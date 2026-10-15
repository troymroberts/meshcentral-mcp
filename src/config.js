import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env parser: KEY=value, optional quotes, '#' comments. Existing environment wins.
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : null;
    if (quote) {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end); // ignore anything after the closing quote
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash);
      value = value.trim();
    }
    out[m[1]] = value;
  }
  return out;
}

// Settings left blank in a Claude Code plugin's configuration reach the server
// as empty strings (or, if never set, possibly as the unexpanded placeholder).
// Treat both as unset so a .env file or the built-in defaults apply.
export function dropBlankSettings(env = process.env) {
  for (const [k, v] of Object.entries(env)) {
    if (/^MESH_/.test(k) && (v === '' || /^\$\{user_config\.[A-Za-z0-9_]+\}$/.test(v))) delete env[k];
  }
}

export function loadDotEnv(env = process.env) {
  dropBlankSettings(env);
  const candidates = [env.MESH_ENV_FILE, path.join(REPO_ROOT, '.env')].filter(Boolean);
  for (const file of candidates) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const [k, v] of Object.entries(parseEnvFile(text))) {
      if (env[k] === undefined) env[k] = v;
    }
    return file;
  }
  return null;
}

export function resolveCredentials(env = process.env) {
  const tokenUser = env.MESH_TOKEN_USER || '';
  const tokenPass = env.MESH_TOKEN_PASS || '';
  const combined = env.MESH_TOKEN || env.MESH_API_KEY || '';

  if (tokenUser || tokenPass) {
    if (!tokenUser || !tokenPass) {
      return { error: 'MESH_TOKEN_USER and MESH_TOKEN_PASS must both be set - a MeshCentral login token is a user/password pair.' };
    }
    return { username: tokenUser, password: tokenPass, kind: 'login token' };
  }

  if (combined) {
    const sep = combined.indexOf(',');
    if (sep === -1) {
      return {
        error:
          'MESH_TOKEN must hold a full MeshCentral login token as "tokenUser,tokenPass" (the pair returned by ' +
          'createLoginToken), or use the separate MESH_TOKEN_USER and MESH_TOKEN_PASS variables. A token password ' +
          'on its own cannot authenticate.',
      };
    }
    const user = combined.slice(0, sep).trim();
    const pass = combined.slice(sep + 1).trim();
    if (!user || !pass) return { error: 'MESH_TOKEN is malformed - expected "tokenUser,tokenPass".' };
    return { username: user, password: pass, kind: 'login token' };
  }

  const username = env.MESH_USERNAME || env.MESH_USER || '';
  const password = env.MESH_PASSWORD || env.MESH_PASS || '';
  if (!username) return { error: 'MESH_USERNAME (or a login token via MESH_TOKEN_USER/MESH_TOKEN_PASS) environment variable is required.' };
  if (!password) return { error: 'MESH_PASSWORD (or a login token via MESH_TOKEN_USER/MESH_TOKEN_PASS) environment variable is required.' };
  return { username, password, kind: 'username/password' };
}

function list(value) {
  return (value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// MESH_MCP_IGNORE_EVENTS: "Provider:id,id;Provider:id" - Windows events that are
// known noise in this environment, left out of the health check's error summary.
export function parseIgnoredEvents(value) {
  const out = [];
  for (const part of String(value ?? '').split(';').map((p) => p.trim()).filter(Boolean)) {
    const m = part.match(/^([\w .\/-]{1,100}):\s*(\d+(?:\s*,\s*\d+)*)$/);
    if (!m) return { error: `MESH_MCP_IGNORE_EVENTS: cannot read "${part}" (expected Provider:id,id).` };
    out.push({ provider: m[1].trim(), ids: m[2].split(',').map((n) => parseInt(n, 10)) });
  }
  return { events: out };
}

function int(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env = process.env) {
  const serverUrl = env.MESH_SERVER_URL || env.MESH_SERVER || '';
  if (!serverUrl) return { error: 'MESH_SERVER_URL environment variable is required.' };
  try { new URL(serverUrl); } catch { return { error: `MESH_SERVER_URL is not a valid URL: ${serverUrl}` }; }

  const credentials = resolveCredentials(env);
  if (credentials.error) return { error: credentials.error };
  const ignored = parseIgnoredEvents(env.MESH_MCP_IGNORE_EVENTS);
  if (ignored.error) return { error: ignored.error };

  return {
    serverUrl,
    credentials,
    rejectUnauthorized: !(env.MESH_INSECURE_TLS === 'true' || env.MESH_INSECURE === 'true'),
    profile: (env.MESH_MCP_PROFILE || 'readonly').toLowerCase(),
    enableTools: list(env.MESH_MCP_ENABLE_TOOLS),
    disableTools: list(env.MESH_MCP_DISABLE_TOOLS),
    confirmTiers: env.MESH_MCP_CONFIRM_TIERS === undefined ? null : list(env.MESH_MCP_CONFIRM_TIERS.toUpperCase()),
    confirmMode: (env.MESH_MCP_CONFIRM_MODE || 'auto').toLowerCase(),
    // Run commands the read-only classifier recognises without a prompt.
    autoApproveReadOnly: bool(env.MESH_MCP_AUTO_APPROVE_READONLY, true),
    // Offer "approve for this session" choices in approval prompts.
    sessionApproval: bool(env.MESH_MCP_SESSION_APPROVAL, true),
    // Push chat messages to Claude Code as channel events (needs the session to load this server as a channel).
    chatPush: bool(env.MESH_MCP_CHAT_PUSH, true),
    chatDiagnostics: bool(env.MESH_MCP_CHAT_DIAGNOSTICS, true),
    // Known-noise Windows events left out of health-check error summaries.
    ignoreEvents: ignored.events,
    ignoreDefaultEvents: bool(env.MESH_MCP_IGNORE_DEFAULT_EVENTS, true),
    // How long an approval prompt waits for the human.
    approvalTimeoutMs: int(env.MESH_MCP_APPROVAL_TIMEOUT_MINUTES, 30) * 60_000,
    // Default / maximum wait for mesh_run_command output.
    commandTimeoutSeconds: int(env.MESH_COMMAND_TIMEOUT_SECONDS, 300),
    commandMaxTimeoutSeconds: int(env.MESH_COMMAND_MAX_TIMEOUT_SECONDS, 3600),
    // Local JSON-lines activity record ('off' disables) and what is also posted to
    // each device's MeshCentral event log: off | changes | all.
    auditLog: auditPath(env.MESH_MCP_AUDIT_LOG, env.CLAUDE_PLUGIN_DATA),
    deviceEvents: (env.MESH_MCP_DEVICE_EVENTS || 'changes').toLowerCase(),
    maxOutputChars: int(env.MESH_MCP_MAX_OUTPUT, 100_000),
    terminalIdleMinutes: int(env.MESH_TERMINAL_IDLE_MINUTES, 15),
    terminalMaxSessions: int(env.MESH_TERMINAL_MAX_SESSIONS, 5),
    desktopIdleMinutes: int(env.MESH_DESKTOP_IDLE_MINUTES, 10),
    desktopMaxSessions: int(env.MESH_DESKTOP_MAX_SESSIONS, 3),
    // Frame interval (ms) requested while the agent is the only KVM viewer; 0 disables throttling.
    desktopIdleFrameMs: nonNegInt(env.MESH_DESKTOP_IDLE_FRAME_MS, 2000),
  };
}

// Default: logs/ in the plugin's persistent data folder when run as a Claude
// Code plugin (the code folder is replaced on every update), else in the repo.
function auditPath(value, dataDir) {
  if (value && /^(off|false|none|0)$/i.test(value.trim())) return null;
  return value ? path.resolve(value) : path.join(dataDir || REPO_ROOT, 'logs', 'audit.jsonl');
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !/^(false|0|no|off)$/i.test(value.trim());
}

function nonNegInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 65_535) : fallback; // wire field is uint16
}
