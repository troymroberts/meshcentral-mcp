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

export function loadDotEnv(env = process.env) {
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

  return {
    serverUrl,
    credentials,
    rejectUnauthorized: !(env.MESH_INSECURE_TLS === 'true' || env.MESH_INSECURE === 'true'),
    profile: (env.MESH_MCP_PROFILE || 'readonly').toLowerCase(),
    enableTools: list(env.MESH_MCP_ENABLE_TOOLS),
    disableTools: list(env.MESH_MCP_DISABLE_TOOLS),
    confirmTiers: env.MESH_MCP_CONFIRM_TIERS === undefined ? null : list(env.MESH_MCP_CONFIRM_TIERS.toUpperCase()),
    confirmMode: (env.MESH_MCP_CONFIRM_MODE || 'auto').toLowerCase(),
    maxOutputChars: int(env.MESH_MCP_MAX_OUTPUT, 100_000),
    terminalIdleMinutes: int(env.MESH_TERMINAL_IDLE_MINUTES, 15),
    terminalMaxSessions: int(env.MESH_TERMINAL_MAX_SESSIONS, 5),
    desktopIdleMinutes: int(env.MESH_DESKTOP_IDLE_MINUTES, 10),
    desktopMaxSessions: int(env.MESH_DESKTOP_MAX_SESSIONS, 3),
    // Frame interval (ms) requested while the agent is the only KVM viewer; 0 disables throttling.
    desktopIdleFrameMs: nonNegInt(env.MESH_DESKTOP_IDLE_FRAME_MS, 2000),
  };
}

function nonNegInt(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 65_535) : fallback; // wire field is uint16
}
