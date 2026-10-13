import { z } from 'zod';
import { FileTunnel } from '../file-tunnel.js';
import { TerminalManager } from '../terminal.js';
import { DesktopManager } from '../desktop.js';
import { isReadOnlyCommand } from '../readonly.js';
import { sanitizeText, errorResult, isServerError, UNTRUSTED_NOTE } from '../safety.js';

// Shared state and helpers for the tool modules in this directory: the define()
// wrapper (policy gating + confirmation), node/group resolution, and the shell,
// console and file-tunnel primitives.

// MCP image content from a captured desktop frame.
function imageResult(enc, header, session = null) {
  const displays = session?.displays ?? enc.displays;
  const selected = session?.selectedDisplay ?? enc.selectedDisplay;
  let line = `${header}\n${enc.width}x${enc.height} (native ${enc.nativeWidth}x${enc.nativeHeight}). Coordinates for click/move are in NATIVE pixels.`;
  if (displays && Object.keys(displays).length > 1) {
    line += `\nDisplays: ${Object.entries(displays).map(([id, name]) => `${id}=${name}`).join(', ')}` +
      `${selected != null ? ` (showing ${selected})` : ''}. Switch with mesh_desktop_set_display.`;
  }
  // Agent-side state that changes what input will do. Device-sourced text is
  // sanitized and fenced like other device output.
  const notices = session?.takeNotices?.() ?? enc.notices ?? [];
  if (session?.inputLocked) line += '\nWARNING: remote input is locked on the device; clicks and keystrokes are being ignored.';
  if (session?.capsLock) line += '\nNote: Caps Lock is on.';
  if (notices.length) {
    line += `\n${UNTRUSTED_NOTE}\n<<<DEVICE_OUTPUT\n` +
      notices.map((n) => `[${n.kind}] ${sanitizeText(n.text)}`).join('\n') + '\nDEVICE_OUTPUT>>>';
  }
  return {
    content: [
      { type: 'text', text: line },
      { type: 'image', data: enc.base64, mimeType: 'image/jpeg' },
    ],
  };
}

// Capability tier of each tool. Drives both profile gating and whether the tool
// is treated as confirmable (X/WF/P/A tools can require approval).
const CONFIRMABLE = new Set(['X', 'WF', 'P', 'A']);

export function createContext({ server, client, policy, gate, config }) {
  const terminals = new TerminalManager({
    client,
    idleMinutes: config.terminalIdleMinutes,
    maxSessions: config.terminalMaxSessions,
  });
  const desktops = new DesktopManager({
    client,
    idleMinutes: config.desktopIdleMinutes,
    maxSessions: config.desktopMaxSessions,
    idleFrameMs: config.desktopIdleFrameMs,
  });

  const registered = [];

  // define() applies policy gating, confirmation, and uniform error handling.
  // autoApprove(args) may return true for calls that are plainly read-only; they
  // skip confirmation when MESH_MCP_AUTO_APPROVE_READONLY is on.
  function define({ name, tier, title, description, schema = {}, annotations = {}, confirmSummary = null, autoApprove = null, handler }) {
    if (!policy.allows(name, tier)) return;
    const confirmable = confirmSummary && CONFIRMABLE.has(tier);
    const inputSchema = { ...schema };
    if (confirmable) {
      inputSchema.confirm_token = z
        .string()
        .optional()
        .describe('Approval token returned by the previous call. Supply it (with identical arguments) only after a human has approved this action.');
    }
    server.registerTool(
      name,
      {
        title,
        description: `[tier ${tier}] ${description}`,
        inputSchema,
        annotations: {
          title,
          readOnlyHint: tier === 'R',
          openWorldHint: true,
          ...annotations,
        },
      },
      async (args, extra) => {
        try {
          if (confirmable && policy.needsConfirm(tier)) {
            const readOnly = policy.autoApproveReadOnly && autoApprove && (await autoApprove(args).catch(() => false));
            if (!readOnly) {
              const summary = await humanizeIds(await confirmSummary(args), args);
              const gateResult = await gate.check(name, summary, args, tier);
              if (gateResult) return gateResult;
            }
          }
          return await handler(args, extra);
        } catch (err) {
          return errorResult(err.message);
        }
      }
    );
    registered.push({ name, tier });
  }

  // ── id helpers ──────────────────────────────────────────────────────────
  const meshId = (raw) => (!raw || raw.includes('/') ? raw : `mesh/${client.domain}/${raw}`);

  // Short-lived cache of the node list so name->id resolution doesn't refetch per call.
  let nodeCache = null;
  let nodeCacheAt = 0;
  async function allNodes() {
    if (nodeCache && Date.now() - nodeCacheAt < 5_000) return nodeCache;
    const res = await client.sendCommand({ action: 'nodes' }, 20_000);
    nodeCache = Object.values(res.nodes || {}).flat();
    nodeCacheAt = Date.now();
    return nodeCache;
  }

  let meshCache = null;
  let meshCacheAt = 0;
  async function allMeshes() {
    if (meshCache && Date.now() - meshCacheAt < 30_000) return meshCache;
    const res = await client.sendCommand({ action: 'meshes' }, 15_000);
    meshCache = Array.isArray(res.meshes) ? res.meshes : [];
    meshCacheAt = Date.now();
    return meshCache;
  }

  // Approval prompts are read by a human: replace node/group IDs (and session IDs)
  // with device and group names. Duplicate device names get an ID suffix so they
  // stay distinguishable. Best effort - on any lookup failure the IDs remain.
  async function humanizeIds(summary, args = {}) {
    if (typeof summary !== 'string') return summary;
    let out = summary;
    try {
      const nodes = await allNodes();
      const nameCount = new Map();
      for (const n of nodes) nameCount.set(n.name, (nameCount.get(n.name) ?? 0) + 1);
      const label = (n) => (nameCount.get(n.name) > 1 ? `${n.name} (${n._id.slice(-6)})` : n.name);
      const byRef = (ref) => nodes.find((n) => n._id === ref) || nodes.find((n) => n._id.split('/')[2] === ref);

      // Session-scoped tools: say which device the session is on.
      if (args.session_id) {
        let nodeId = null;
        try { nodeId = terminals.get(args.session_id).nodeId; } catch {}
        if (!nodeId) try { nodeId = desktops.get(args.session_id).nodeId; } catch {}
        const n = nodeId && byRef(nodeId);
        if (n) out = out.split(args.session_id).join(`${args.session_id} on ${label(n)}`);
      }

      const refs = new Set([
        ...(out.match(/node\/[\w.-]*\/[\w@$-]+/g) || []),
        ...[args.node_id, ...(Array.isArray(args.node_ids) ? args.node_ids : [])].filter((v) => typeof v === 'string'),
      ]);
      for (const ref of [...refs].sort((a, b) => b.length - a.length)) {
        const n = byRef(ref);
        if (n) out = out.split(ref).join(label(n));
      }
    } catch {}
    try {
      const meshRef = args.meshid ?? args.mesh_id;
      if (typeof meshRef === 'string') {
        const meshes = await allMeshes();
        const m = meshes.find((x) => x._id === meshRef || x._id === meshId(meshRef));
        if (m?.name) out = out.split(meshRef).join(`"${m.name}"`);
      }
    } catch {}
    return out;
  }

  async function getNode(idOrName) {
    const nodes = await allNodes();
    return (
      nodes.find((n) => n._id === idOrName) ||
      nodes.find((n) => n.name === idOrName) ||
      nodes.find((n) => n._id.split('/')[2] === idOrName) ||
      null
    );
  }

  // Resolve a node ID or name to a full node id. A '/'-form is trusted as-is;
  // a bare token is matched against the node list by id-hash or name, else
  // completed as node/<domain>/<token> so the server returns a clean error.
  async function resolveNodeId(raw) {
    if (!raw || raw.includes('/')) return raw;
    const node = await getNode(raw);
    return node ? node._id : `node/${client.domain}/${raw}`;
  }
  const resolveNodeIds = (arr) => Promise.all(arr.map(resolveNodeId));

  const isWindowsNode = (node) => {
    const id = node?.agent?.id;
    if (typeof id === 'number') return (id >= 1 && id <= 4) || (id >= 42 && id <= 43);
    return /win/i.test(node?.osdesc || '');
  };

  // Decode MeshCentral's connection/power bitfields so "is it online?" is answerable
  // from the tier-R inventory tools without running anything on the device.
  const CONN_BITS = [[1, 'agent'], [2, 'intel-amt-cira'], [4, 'intel-amt'], [8, 'relay'], [16, 'mqtt']];
  const POWER_STATES = ['unknown', 'on', 'sleep', 'sleep', 'sleep', 'hibernate', 'off', 'present'];
  const withStatus = (node) => {
    const conn = node?.conn ?? 0;
    const connection = CONN_BITS.filter(([bit]) => conn & bit).map(([, label]) => label);
    return {
      online: Boolean(conn & 1),
      connection: connection.length ? connection : ['offline'],
      ...(node?.pwr != null ? { power: POWER_STATES[node.pwr] ?? `state ${node.pwr}` } : {}),
      ...node,
    };
  };

  // Shell dialect the read-only classifier should apply to a command for a node.
  // type 0 (auto) on Windows may run under either CMD or PowerShell, so it must
  // satisfy both.
  const RUN_TYPE_LABEL = { 0: 'auto', 1: 'CMD', 2: 'PowerShell', 3: 'shell' };
  function readOnlyFor(node, command, type) {
    if (type === 1) return isReadOnlyCommand(command, 'cmd');
    if (type === 2) return isReadOnlyCommand(command, 'powershell');
    if (type === 3) return isReadOnlyCommand(command, 'posix');
    if (isWindowsNode(node)) return isReadOnlyCommand(command, 'cmd') && isReadOnlyCommand(command, 'powershell');
    return isReadOnlyCommand(command, 'posix');
  }

  // Keep long-running calls visibly alive: clients that track MCP progress (and
  // may reset their own request timeout on it) get a heartbeat while we wait.
  async function withProgress(extra, label, fn, everyMs = 10_000) {
    const token = extra?._meta?.progressToken;
    if (token == null || !extra?.sendNotification) return fn();
    const started = Date.now();
    const timer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: secs, message: `${label} (${secs}s elapsed)` },
      }).catch(() => {});
    }, everyMs);
    try { return await fn(); } finally { clearInterval(timer); }
  }

  // Read-only MeshAgent console commands (exact command word; arguments allowed
  // only where noted).
  const READONLY_AGENT_CONSOLE = new Set([
    'help', 'info', 'coreinfo', 'sysinfo', 'netinfo', 'osinfo', 'cpuinfo', 'versions', 'args', 'uptime',
    'location', 'timerinfo', 'wslist', 'agentsize', 'vm', 'apf', 'privacybar', 'kvmmode', 'wpfhwacceleration',
  ]);

  // Run a shell command and return the agent's captured output. type: 1 CMD, 2 PS, 3 *nix, 0 auto.
  // On success the agent replies {action:'msg', type:'runcommands', result:<output>}; on failure the
  // server replies {action:'runcommands', result:<status>}, where result is a status, not output.
  // The agent runs one runcommands at a time per device. A second one sent while
  // it is busy is refused with a console message ("already busy") and never gets
  // a reply, so calls are queued per node and the refusal is surfaced at once.
  const shellQueues = new Map(); // nodeId -> tail promise
  const BUSY_RE = /run commands can'?t execute, already busy/i;

  async function runShell(node, command, type = 0, timeoutMs = 30_000) {
    const prev = shellQueues.get(node._id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => runShellNow(node, command, type, timeoutMs));
    const tail = run.catch(() => {});
    shellQueues.set(node._id, tail);
    tail.then(() => { if (shellQueues.get(node._id) === tail) shellQueues.delete(node._id); });
    return run;
  }

  async function runShellNow(node, command, type, timeoutMs) {
    let offBusy = () => {};
    const busy = new Promise((_, reject) => {
      offBusy = client.on('msg', (m) => {
        if (m.type === 'console' && m.nodeid === node._id && BUSY_RE.test(String(m.value ?? ''))) {
          reject(new Error(
            `${node.name}'s agent is still running an earlier command (it may be one that timed out here and is still ` +
            'executing on the device), so it refused this one. Use a persistent terminal (mesh_terminal_open + ' +
            'mesh_terminal_input) instead - it is not blocked by this - or wait for the earlier command to finish; ' +
            'restarting the Mesh Agent service clears a stuck command.'
          ));
        }
      });
    });
    let res;
    try {
      res = await Promise.race([
        client.sendCommand({ action: 'runcommands', nodeids: [node._id], cmds: command, type, reply: true }, timeoutMs),
        busy,
      ]);
    } catch (err) {
      if (/did not answer/.test(err.message)) {
        throw new Error(
          `No output from ${node.name} within ${Math.round(timeoutMs / 1000)}s. The command may still be running on the device ` +
          '(it is not cancelled, and the agent refuses further commands until it ends). Retry with a larger timeout_seconds, ' +
          'narrow the query (e.g. -MaxEvents / --since), or use an interactive terminal (mesh_terminal_*) for long-running work.'
        );
      }
      throw err;
    } finally {
      offBusy();
    }
    if (res.action === 'runcommands' && res.result && res.result !== 'OK') throw new Error(`MeshCentral: ${res.result}`);
    return typeof res.result === 'string' ? res.result : '';
  }


  // Agent console command (type 4). Output arrives as pushed msg/console frames, not a reply.
  async function runConsole(node, command, { idleMs = 1500, maxMs = 45_000 } = {}) {
    const msgs = await client.collectMessages(
      (m) => m.action === 'msg' && m.type === 'console' && m.nodeid === node._id,
      async () => {
        const res = await client.sendCommand(
          { action: 'runcommands', nodeids: [node._id], cmds: command, type: 4, reply: true },
          15_000
        );
        if (isServerError(res)) throw new Error(`MeshCentral: ${res.result}`);
      },
      { idleMs, maxMs, firstMs: 20_000 }
    );
    return msgs.map((m) => m.value).join('\n');
  }

  async function withFileTunnel(idOrName, fn) {
    const ws = await client.openRelay(await resolveNodeId(idOrName), 5);
    const tunnel = new FileTunnel(ws);
    try {
      return await fn(tunnel);
    } finally {
      tunnel.close();
    }
  }

  return {
    server, client, policy, gate, config, registered, terminals, desktops, define,
    meshId, allNodes, allMeshes, humanizeIds, getNode, resolveNodeId, resolveNodeIds, isWindowsNode, withStatus,
    RUN_TYPE_LABEL, readOnlyFor, withProgress, READONLY_AGENT_CONSOLE, runShell, runConsole, withFileTunnel, imageResult,
  };
}
