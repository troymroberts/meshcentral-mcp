import crypto from 'crypto';
import { z } from 'zod';
import { FileTunnel } from '../file-tunnel.js';
import { RegistryTunnel } from '../registry-tunnel.js';
import { TerminalManager } from '../terminal.js';
import { DesktopManager } from '../desktop.js';
import { ChatManager } from '../chat.js';
import { isReadOnlyCommand } from '../readonly.js';
import { sanitizeText, errorResult, isServerError, deviceResult, UNTRUSTED_NOTE } from '../safety.js';
import { AGENT_GUARD_MESSAGE } from '../agent-guard.js';
import { AuditLog, redactArgs } from '../audit.js';

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

// Tiers whose calls change a device (posted to its MeshCentral event log under
// MESH_MCP_DEVICE_EVENTS=changes unless auto-approved as read-only).
const CHANGE_TIERS = new Set(['W', 'X', 'WF', 'P', 'A']);

const firstLine = (result) => String(result?.content?.[0]?.text ?? '').split('\n')[0].slice(0, 300);

export function createContext({ server, client, policy, gate, config, audit = new AuditLog() }) {
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
  // Chat events are pushed to the client as Claude Code channel events
  // (notifications/claude/channel). A client that has not loaded this server as
  // a channel drops them silently; mesh_chat_read still returns every message.
  const diagnosticsText = (session) => {
    const d = session.diagnostics;
    if (!d || d.status === 'running') return `Background diagnostics for ${session.nodeName} are still running.`;
    if (d.status === 'failed') return `Background diagnostics for ${session.nodeName} failed: ${d.error}`;
    const secs = Math.round((d.finishedAt - d.startedAt) / 1000);
    return `Background diagnostics for ${session.nodeName} (started with the chat, took ${secs}s; read-only):\n` +
      deviceResult(d.text).content[0].text;
  };
  const pushChatEvent = (session, kind, text) => {
    if (config.chatPush === false || !server.server?.notification) return;
    const meta = { chat_id: session.id, device: session.nodeName, event: kind };
    const content = kind === 'message'
      ? `${session.nodeName} user wrote:\n${deviceResult(text).content[0].text}`
      : kind === 'joined' ? `The user at ${session.nodeName} joined the chat.`
      : kind === 'diagnostics' ? diagnosticsText(session)
      : `The chat with ${session.nodeName} ended (${text}).`;
    server.server.notification({ method: 'notifications/claude/channel', params: { content, meta } }).catch(() => {});
  };
  const chats = new ChatManager({ client, idleMinutes: config.chatIdleMinutes ?? 30, onEvent: pushChatEvent });

  const registered = [];
  const known = []; // every tool name, registered or not (to catch typos in ENABLE/DISABLE_TOOLS)

  const PURPOSE_SCHEMA = z.string().min(1).describe(
    'One plain-English sentence for the human: what this command does and why you are running it now, ' +
    'e.g. "List services that are set to start automatically but are stopped, to find why printing fails". ' +
    'No jargon the command itself does not need.'
  );
  const purposeOf = (args) => String(args?.purpose ?? '').replace(/\s+/g, ' ').trim();
  const APPROVAL_LABEL = {
    'auto-readonly': 'auto-approved (read-only)',
    prompt: 'approved by you',
    token: 'approved by you (token)',
    grant: 'covered by a session approval you gave',
    off: 'confirmation disabled',
    'not-required': 'not required by policy',
  };

  // define() applies policy gating, the Mesh Agent guard, confirmation, the
  // activity record, and uniform error handling.
  //   autoApprove(args)  true for plainly read-only calls; they skip confirmation
  //                      when MESH_MCP_AUTO_APPROVE_READONLY is on
  //   agentRisk(args)    reason string when the call would stop/kill/modify the Mesh
  //                      Agent: refused unless allow_agent_disruption, and then
  //                      always prompted (session grants do not apply)
  //   audit              false keeps a tool out of the activity record (lookups)
  //   change(args)       whether a call changes the device; default: W/X/WF/P/A
  //                      tiers unless it was read-only
  //   describe(args)     record summary for tools without a confirmSummary
  //   explain            require a plain-English `purpose` argument: it leads the
  //                      approval prompt, heads the result and goes into the record
  //   sensitive          true, or (args) => boolean: ask whatever the tier
  //                      (one-off screenshots, clipboard, opening URLs on the device)
  //   confirm            false for calls that never need approval (closing a session)
  // A tool asks when its tier is in MESH_MCP_CONFIRM_TIERS (default X/WF/P/A),
  // when it is sensitive, or when agentRisk fires.
  function define({
    name, tier, title, description, schema = {}, annotations = {}, confirmSummary = null, autoApprove = null,
    agentRisk = null, audit: auditable = tier !== 'R', change = null, describe = null, explain = false,
    sensitive = false, confirm = true, handler,
  }) {
    known.push(name);
    if (!policy.allows(name, tier)) return;
    const tierAsks = confirm && policy.needsConfirm(tier);
    const asksFor = (args) => tierAsks || (confirm && (typeof sensitive === 'function' ? sensitive(args) : sensitive));
    const confirmable = tierAsks || (confirm && Boolean(sensitive)) || Boolean(agentRisk);
    const summarize = async (args) => confirmSummary ? confirmSummary(args)
      : describe ? describe(args)
      : `${title}: ${JSON.stringify(redactArgs(args))}`;
    // purpose goes first: clients show the leading arguments of a collapsed call.
    const inputSchema = explain ? { purpose: PURPOSE_SCHEMA, ...schema } : { ...schema };
    if (agentRisk) {
      inputSchema.allow_agent_disruption = z
        .boolean()
        .optional()
        .describe('Only when the human explicitly asked to stop/restart/modify the Mesh Agent itself. Always prompts; can permanently cut off remote access.');
    }
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
        const started = Date.now();
        let approval = 'not-required';
        let summary = null;
        let nodes = [];
        let result;
        try {
          nodes = await nodesOf(args);
          const readOnly = Boolean(autoApprove) && (await autoApprove(args).catch(() => false));
          const risk = agentRisk && !readOnly ? await agentRisk(args) : null;
          if (risk && !args.allow_agent_disruption) {
            approval = 'blocked';
            result = errorResult(`${AGENT_GUARD_MESSAGE}\nReason: ${risk}.`);
          } else {
            if (risk || (asksFor(args) && !(readOnly && policy.autoApproveReadOnly))) {
              summary = await humanizeIds(await summarize(args), args);
              const why = explain ? `Purpose: ${purposeOf(args)}\n` : '';
              const prompt = risk ? `WARNING - MAY CUT OFF REMOTE ACCESS (${risk}).\n${why}${summary}` : `${why}${summary}`;
              const device = nodes.length === 1 ? { id: nodes[0].id, label: nodes[0].name } : null;
              const d = await gate.decide(name, prompt, args, tier, {
                nodeIds: nodes.map((n) => n.id), device, forcePrompt: Boolean(risk),
              });
              approval = d.via;
              if (d.block) result = d.block;
            } else if (readOnly) {
              approval = 'auto-readonly';
            }
            if (!result) {
              result = await handler(args, extra);
              // A change can rename, retag or move devices: don't serve the cached list after it.
              if (CHANGE_TIERS.has(tier)) { nodeCache = null; meshCache = null; }
              if (explain) result = withPurpose(result, args, approval);
            }
          }
        } catch (err) {
          result = errorResult(err.message);
        }
        if (auditable && approval !== 'token-issued') {
          try {
            if (summary == null) {
              summary = describe ? await describe(args)
                : confirmSummary ? await humanizeIds(await confirmSummary(args), args)
                : `${name} ${JSON.stringify(redactArgs(args))}`;
            }
            if (explain && purposeOf(args)) summary = `${summary} (purpose: ${purposeOf(args)})`;
            const executed = !['blocked', 'denied'].includes(approval);
            const isChange = executed && (change ? change(args, approval) : CHANGE_TIERS.has(tier) && approval !== 'auto-readonly');
            const text = firstLine(result);
            const background = Boolean(result?.isError) && /Tracked as job (job_\w+)/.test(text);
            audit.record({
              tool: name, tier, nodes, summary, approval, ok: !result?.isError || background,
              ...(background ? { outcome: `continuing as background ${text.match(/job_\w+/)[0]}` } : {}),
              ...(result?.isError && !background ? { error: text } : {}),
              ms: Date.now() - started, change: isChange,
            });
          } catch {}
        }
        return result;
      }
    );
    registered.push({ name, tier });
  }

  // Heads a command result with what it was for and how it was approved, so the
  // human reading the call sees intent first, then command and output.
  function withPurpose(result, args, approval) {
    const how = APPROVAL_LABEL[approval];
    const head = `Purpose: ${purposeOf(args)}${how ? `\nApproval: ${how}` : ''}`;
    const [first, ...rest] = result?.content ?? [];
    if (first?.type !== 'text') return result;
    return { ...result, content: [{ ...first, text: `${head}\n${first.text}` }, ...rest] };
  }

  // Devices a call touches, for approval scoping and the activity record.
  async function nodesOf(args = {}) {
    const refs = [];
    if (typeof args.node_id === 'string') refs.push(args.node_id);
    if (Array.isArray(args.node_ids)) refs.push(...args.node_ids.filter((r) => typeof r === 'string'));
    if (typeof args.session_id === 'string') {
      try { refs.push(terminals.get(args.session_id).nodeId); } catch {}
      try { refs.push(desktops.get(args.session_id).nodeId); } catch {}
    }
    if (typeof args.chat_id === 'string') {
      try { refs.push(chats.get(args.chat_id).nodeId); } catch {}
    }
    if (typeof args.job_id === 'string' && jobs.has(args.job_id)) refs.push(jobs.get(args.job_id).nodeId);
    const out = [];
    for (const ref of refs) {
      const n = await getNode(ref).catch(() => null);
      if (n && !out.some((x) => x.id === n._id)) out.push({ id: n._id, name: n.name });
    }
    return out;
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

  // Find a device by full ID, ID hash, or name. Names match exactly, then
  // case-insensitively, then as a unique partial match ignoring punctuation
  // ("prudecon file" finds "Prudecon-File"). Several matches throw, listing them.
  // Returns null when nothing matches.
  const squash = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  async function getNode(ref) {
    if (typeof ref !== 'string' || !ref) return null;
    const nodes = await allNodes();
    const byId = nodes.find((n) => n._id === ref) || nodes.find((n) => n._id.split('/')[2] === ref);
    if (byId) return byId;
    const pick = (matches) => {
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new Error(
          `'${ref}' matches ${matches.length} devices: ` +
          matches.slice(0, 15).map((n) => `${n.name} (${n._id})`).join(', ') + '. Use the exact name or node ID.'
        );
      }
      return null;
    };
    const lower = ref.toLowerCase();
    const needle = squash(ref);
    return (
      pick(nodes.filter((n) => n.name === ref)) ||
      pick(nodes.filter((n) => n.name?.toLowerCase() === lower)) ||
      (needle ? pick(nodes.filter((n) => squash(n.name).includes(needle))) : null)
    );
  }

  // getNode, but a miss is an error that lists known device names.
  async function requireNode(ref) {
    const node = await getNode(ref);
    if (node) return node;
    const names = (await allNodes()).map((n) => n.name).sort();
    throw new Error(
      `No device matching '${ref}'. Known devices${names.length > 30 ? ' (first 30)' : ''}: ` +
      `${names.slice(0, 30).join(', ') || '(none visible to this account)'}.`
    );
  }

  // Resolve a node ID or name to a full node id. A '/'-form is trusted as-is.
  async function resolveNodeId(raw) {
    if (!raw || raw.includes('/')) return raw;
    return (await requireNode(raw))._id;
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
  const ago = (ms) => {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 120) return `${s}s ago`;
    if (s < 7200) return `${Math.round(s / 60)}m ago`;
    if (s < 172800) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };
  // last: optional { time, addr } from lastConnect()/lastConnects().
  const withStatus = (node, last = null) => {
    const conn = node?.conn ?? 0;
    const connection = CONN_BITS.filter(([bit]) => conn & bit).map(([, label]) => label);
    return {
      online: Boolean(conn & 1),
      connection: connection.length ? connection : ['offline'],
      ...(node?.pwr != null ? { power: POWER_STATES[node.pwr] ?? `state ${node.pwr}` } : {}),
      ...(last?.time ? {
        last_connected: new Date(last.time).toISOString(),
        last_connected_ago: ago(last.time),
        ...(last.addr ? { last_address: last.addr } : {}),
      } : {}),
      ...node,
    };
  };

  async function lastConnect(nodeId) {
    try {
      const r = await client.sendCommand({ action: 'lastconnect', nodeid: nodeId }, 10_000);
      return r?.time ? { time: r.time, addr: r.addr } : null;
    } catch { return null; }
  }

  async function lastConnects() {
    try {
      const r = await client.sendCommand({ action: 'lastconnects' }, 15_000);
      return r?.lastconnects ?? {};
    } catch { return {}; }
  }

  // A device's MeshCentral event log, newest first. filter: one of the server's
  // action filters (manual, runcommands, relaylog, agentlog, changenode, ...).
  async function deviceEvents(nodeId, { limit = 50, filter = null } = {}) {
    const res = await client.sendCommand({ action: 'events', nodeid: nodeId, limit, ...(filter ? { filter } : {}) }, 20_000);
    return Array.isArray(res?.events) ? res.events : [];
  }

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

  // ── Shell commands and background jobs ──────────────────────────────────
  // Run a shell command and return the agent's captured output. type: 1 CMD, 2 PS, 3 *nix, 0 auto.
  // On success the agent replies {action:'msg', type:'runcommands', result:<output>}; on failure the
  // server replies {action:'runcommands', result:<status>}, where result is a status, not output.
  //
  // The agent runs one runcommands at a time per device. A second one sent while
  // it is busy is refused with a console message ("already busy") and never gets
  // a reply. So every command is a job, queued per node; the queue is held until
  // the agent actually replies (up to MESH_COMMAND_MAX_TIMEOUT_SECONDS), even if
  // the caller stopped waiting, and the late result stays fetchable by job ID.
  const shellQueues = new Map(); // nodeId -> tail promise
  const jobs = new Map(); // jobId -> job
  const runningJobs = new Map(); // nodeId -> the job currently sent to that agent
  const BUSY_RE = /run commands can'?t execute, already busy/i;
  const MAX_JOBS = 200;
  const jobFinished = (job) => job.status === 'done' || job.status === 'failed';

  // visible: listed by mesh_job_status. Jobs behind other tools stay hidden
  // unless they outlive their caller's wait.
  function startShellJob(node, command, type = 0, { visible = true } = {}) {
    const job = {
      id: `job_${crypto.randomBytes(4).toString('hex')}`,
      nodeId: node._id, nodeName: node.name, command, type, visible,
      status: 'queued', queuedAt: Date.now(), startedAt: null, endedAt: null, output: null, error: null,
      abort: null, // set while running: abort(reason) fails the job and releases the queue
    };
    const lifetimeMs = config.commandMaxTimeoutSeconds * 1000;
    const prev = shellQueues.get(node._id) ?? Promise.resolve();
    job.promise = prev.then(async () => {
      if (job.status === 'failed') return; // cancelled while queued
      job.status = 'running';
      job.startedAt = Date.now();
      runningJobs.set(node._id, job);
      const aborted = new Promise((_, reject) => { job.abort = (reason) => reject(new Error(reason)); });
      try {
        const out = await Promise.race([runShellNow(node, command, type, lifetimeMs), aborted]);
        job.output = cleanShellOutput(out, node, type);
        job.status = 'done';
      } catch (err) {
        job.error = err.message;
        job.status = 'failed';
      } finally {
        job.abort = null;
        job.endedAt = Date.now();
        if (runningJobs.get(node._id) === job) runningJobs.delete(node._id);
      }
    });
    shellQueues.set(node._id, job.promise);
    job.promise.then(() => { if (shellQueues.get(node._id) === job.promise) shellQueues.delete(node._id); });
    jobs.set(job.id, job);
    if (jobs.size > MAX_JOBS) {
      for (const [id, j] of jobs) { if (jobs.size <= MAX_JOBS) break; if (jobFinished(j)) jobs.delete(id); }
    }
    return job;
  }

  // Stop tracking a job. A running one is failed with `reason` and the device's
  // queue moves on (the command may still be running on the device); a queued
  // one is dropped before it is sent.
  function cancelJob(job, reason) {
    if (jobFinished(job)) return false;
    if (job.status === 'running' && job.abort) {
      job.abort(reason);
    } else {
      job.status = 'failed';
      job.error = reason;
      job.endedAt = Date.now();
    }
    return true;
  }

  // An agent restart kills whatever it was running, and its reply never comes.
  // MeshCentral announces agent connect/disconnect as "nodeconnect" events: fail
  // the running job on that device when its agent goes away, or when it is seen
  // (re)connected after the job started.
  client.on('event', (m) => {
    const e = m?.event;
    if (e?.action !== 'nodeconnect' || !e.nodeid) return;
    const job = runningJobs.get(e.nodeid);
    if (!job) return;
    if (!((e.conn ?? 0) & 1)) {
      cancelJob(job, `The Mesh Agent on ${job.nodeName} disconnected while this command was running; its result is lost.`);
    } else if (e.ct && e.ct > job.startedAt) {
      cancelJob(job, `The Mesh Agent on ${job.nodeName} restarted/reconnected while this command was running; its result is lost.`);
    }
  });

  // Wait up to ms for a job to finish (no-op if it already has).
  async function waitForJob(job, ms) {
    if (jobFinished(job) || ms <= 0) return;
    let timer;
    await Promise.race([job.promise, new Promise((r) => { timer = setTimeout(r, ms); timer.unref?.(); })]);
    clearTimeout(timer);
  }

  const stillRunningMessage = (job, waitedMs) => {
    const ahead = job.status === 'queued' ? runningJobs.get(job.nodeId) : null;
    const behind = ahead
      ? `Still queued on ${job.nodeName} behind job ${ahead.id} (running ${Math.round((Date.now() - ahead.startedAt) / 1000)}s: ` +
        `${ahead.command.length > 80 ? ahead.command.slice(0, 80) + '…' : ahead.command}). If that job is stuck (e.g. the ` +
        `agent was restarted), release it with mesh_job_cancel.`
      : `${job.status === 'queued' ? 'Still queued behind an earlier command' : 'Still running'} on ${job.nodeName}.`;
    return `${behind} Waited ${Math.round(waitedMs / 1000)}s. Tracked as job ${job.id}: fetch the result later with ` +
      `mesh_job_status (job_id "${job.id}"). A terminal (mesh_terminal_*) is not blocked by the queue.`;
  };

  // Run and wait up to timeoutMs. On timeout the job keeps running and the error names it.
  async function runShell(node, command, type = 0, timeoutMs = 30_000) {
    const job = startShellJob(node, command, type, { visible: false });
    await waitForJob(job, timeoutMs);
    if (job.status === 'done') return job.output;
    if (job.status === 'failed') throw new Error(job.error);
    job.visible = true;
    throw new Error(stillRunningMessage(job, timeoutMs));
  }

  // CMD on Windows (type 1, and type 0 which runs CMD) wraps output in its banner,
  // the echoed command line and a trailing "exit"; strip those.
  function cleanShellOutput(out, node, type) {
    if (typeof out !== 'string' || !(type === 1 || (type === 0 && isWindowsNode(node)))) return out;
    const lines = out.split(/\r?\n/);
    let i = 0;
    if (/^Microsoft Windows \[Version/.test(lines[i] ?? '')) i++;
    if (/^\(c\) .*Microsoft Corporation/.test(lines[i] ?? '')) i++;
    while (i < lines.length && !lines[i].trim()) i++;
    if (/^[A-Za-z]:\\[^>]*>/.test(lines[i] ?? '')) i++; // echoed command line
    let end = lines.length;
    while (end > i && !lines[end - 1].trim()) end--;
    if (end > i && /^[A-Za-z]:\\[^>]*>exit$/.test(lines[end - 1].trim())) end--;
    while (end > i && !lines[end - 1].trim()) end--;
    return lines.slice(i, end).join('\n');
  }

  async function runShellNow(node, command, type, timeoutMs) {
    let offBusy = () => {};
    const busy = new Promise((_, reject) => {
      offBusy = client.on('msg', (m) => {
        if (m.type === 'console' && m.nodeid === node._id && BUSY_RE.test(String(m.value ?? ''))) {
          reject(new Error(
            `${node.name}'s agent is busy with a command this server did not start (another MeshCentral user or tool, ` +
            'or one from before this server restarted), so it refused this one. Use a persistent terminal ' +
            '(mesh_terminal_open + mesh_terminal_input) - it is not blocked by this - or wait for that command to finish.'
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
          `No reply from ${node.name} within ${Math.round(timeoutMs / 1000)}s (MESH_COMMAND_MAX_TIMEOUT_SECONDS); the ` +
          'command may still be running on the device and blocking further commands there.'
        );
      }
      throw err;
    } finally {
      offBusy();
    }
    if (res.action === 'runcommands' && res.result && res.result !== 'OK') throw new Error(`MeshCentral: ${res.result}`);
    return typeof res.result === 'string' ? res.result : '';
  }

  // The agent's process list: { pid: { cmd, user, ... } }, or null when the device
  // does not answer.
  async function processList(nodeId) {
    const msgs = await client.collectMessages(
      (m) => m.action === 'msg' && m.type === 'ps' && m.nodeid === nodeId,
      () => client.sendRaw({ action: 'msg', type: 'ps', nodeid: nodeId }),
      { idleMs: 500, firstMs: 15_000, maxMs: 20_000 }
    );
    if (!msgs.length) return null;
    let value = msgs[msgs.length - 1].value;
    try { value = JSON.parse(value); } catch {}
    return value;
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

  // Server plugin action over the user websocket ({action:'plugin', plugin, pluginaction}).
  // MeshCentral hands it to the plugin's serveraction as this account, so the plugin's own
  // permission checks apply. Plugins following the inventory plugin's convention answer with
  // {action:'plugin', plugin, method, requestId, ok, result, error}; no answer means the
  // plugin is not installed (MeshCentral drops actions for unknown plugins silently).
  async function pluginAction(plugin, pluginaction, payload = {}, timeoutMs = 30_000) {
    const requestId = `mcp_${crypto.randomBytes(6).toString('hex')}`;
    const reply = client.waitForMessage((m) => m.action === 'plugin' && m.plugin === plugin && m.requestId === requestId, timeoutMs);
    reply.catch(() => {});
    await client.sendRaw({ ...payload, action: 'plugin', plugin, pluginaction, requestId });
    let msg;
    try {
      msg = await reply;
    } catch {
      throw new Error(`The MeshCentral '${plugin}' plugin did not answer '${pluginaction}' within ${timeoutMs / 1000}s (not installed, disabled, or an older version without this action?)`);
    }
    if (!msg.ok) throw new Error(`${plugin} plugin: ${msg.error || 'request failed'}`);
    return msg.result;
  }

  // Remote registry relay (protocol 4; MeshCentral 1.3.0+, Windows agents).
  async function withRegistryTunnel(idOrName, fn) {
    const ws = await client.openRelay(await resolveNodeId(idOrName), 4);
    const tunnel = new RegistryTunnel(ws);
    try {
      return await fn(tunnel);
    } finally {
      tunnel.close();
    }
  }

  // MeshCentral server version as [major, minor, patch], cached for the session;
  // null when the server does not say.
  let serverVersionCache;
  async function serverVersion() {
    if (serverVersionCache !== undefined) return serverVersionCache;
    try {
      const res = await client.sendCommand({ action: 'serverversion' }, 10_000);
      const m = /^(\d+)\.(\d+)\.(\d+)/.exec(res?.tags?.current ?? '');
      serverVersionCache = m ? m.slice(1).map(Number) : null;
    } catch { serverVersionCache = null; }
    return serverVersionCache;
  }
  const versionAtLeast = (v, min) => Boolean(v) && (v[0] - min[0] || v[1] - min[1] || v[2] - min[2]) >= 0;

  // MeshCentral's native 'software' action (the Software tab): type 'installedapps',
  // 'installedstoreapps' or 'uninstallapp'. The agent answers with a separate
  // 'software' message. Sent without a responseid: MeshCentral 1.3.0 answers any
  // 'software' request carrying a responseid with an immediate 'Denied'.
  // accept(data) picks the reply to wait for when the agent sends several
  // (an uninstall first reports 'started', then the exit code).
  const parseSoftwareValue = (msg) => {
    let data = msg.value;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* plain text */ } }
    return data;
  };
  async function nativeSoftware(nodeId, type, value, timeoutMs = 120_000, accept = null) {
    const reply = client.waitForMessage((m) => {
      if (m.action !== 'software' || (m.nodeid != null && m.nodeid !== nodeId)) return false;
      if (typeof m.result === 'string' && m.value == null) return true; // server refusal ('Denied', 'Agent offline')
      const data = parseSoftwareValue(m);
      return !accept || Boolean(data?.error) || accept(data);
    }, timeoutMs);
    reply.catch(() => {});
    await client.sendRaw({ action: 'software', nodeid: nodeId, type, ...(value != null ? { value } : {}) });
    const msg = await reply;
    if (typeof msg.result === 'string' && msg.value == null) throw new Error(`MeshCentral: ${msg.result}`);
    const data = parseSoftwareValue(msg);
    if (data && !Array.isArray(data) && data.error) throw new Error(String(data.error));
    return data;
  }

  return {
    server, client, policy, gate, config, audit, registered, known, terminals, desktops, chats, define, diagnosticsText,
    meshId, allNodes, allMeshes, humanizeIds, getNode, requireNode, resolveNodeId, resolveNodeIds, isWindowsNode,
    withStatus, lastConnect, lastConnects, deviceEvents, ago,
    RUN_TYPE_LABEL, readOnlyFor, withProgress, READONLY_AGENT_CONSOLE,
    runShell, startShellJob, waitForJob, cancelJob, jobs, runningJobs, jobFinished, stillRunningMessage,
    runConsole, processList, withFileTunnel, withRegistryTunnel, pluginAction, serverVersion, versionAtLeast, nativeSoftware, imageResult,
  };
}
