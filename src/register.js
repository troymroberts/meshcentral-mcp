import fs from 'fs';
import { z } from 'zod';
import { resolveLocalPath } from './local-path.js';
import { FileTunnel, splitRemotePath, joinRemotePath } from './file-tunnel.js';
import { TerminalManager, waitForOutput, SHELLS } from './terminal.js';
import { DesktopManager, waitForFrame, vkFor, VK } from './desktop.js';
import { sanitizeText, textResult, deviceResult, serverResult, errorResult, isServerError } from './safety.js';

// MCP image content from a captured desktop frame.
function imageResult(enc, header, session = null) {
  const displays = session?.displays ?? enc.displays;
  const selected = session?.selectedDisplay ?? enc.selectedDisplay;
  let line = `${header}\n${enc.width}x${enc.height} (native ${enc.nativeWidth}x${enc.nativeHeight}). Coordinates for click/move are in NATIVE pixels.`;
  if (displays && Object.keys(displays).length > 1) {
    line += `\nDisplays: ${Object.entries(displays).map(([id, name]) => `${id}=${name}`).join(', ')}` +
      `${selected != null ? ` (showing ${selected})` : ''}. Switch with mesh_desktop_set_display.`;
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

export function registerTools({ server, client, policy, gate, config }) {
  const terminals = new TerminalManager({
    client,
    idleMinutes: config.terminalIdleMinutes,
    maxSessions: config.terminalMaxSessions,
  });
  const desktops = new DesktopManager({
    client,
    idleMinutes: config.desktopIdleMinutes,
    maxSessions: config.desktopMaxSessions,
  });

  const registered = [];

  // define() applies policy gating, confirmation, and uniform error handling.
  function define({ name, tier, title, description, schema = {}, annotations = {}, confirmSummary = null, handler }) {
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
      async (args) => {
        try {
          if (confirmable && policy.needsConfirm(tier)) {
            const gateResult = await gate.check(name, confirmSummary(args), args);
            if (gateResult) return gateResult;
          }
          return await handler(args);
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

  // Run a shell command and return the agent's captured output. type: 1 CMD, 2 PS, 3 *nix, 0 auto.
  // On success the agent replies {action:'msg', type:'runcommands', result:<output>}; on failure the
  // server replies {action:'runcommands', result:<status>}, where result is a status, not output.
  async function runShell(node, command, type = 0, timeoutMs = 30_000) {
    const res = await client.sendCommand(
      { action: 'runcommands', nodeids: [node._id], cmds: command, type, reply: true },
      timeoutMs
    );
    if (res.action === 'runcommands' && res.result && res.result !== 'OK') throw new Error(`MeshCentral: ${res.result}`);
    return typeof res.result === 'string' ? res.result : '';
  }

  // Agent console command (type 4). Output arrives as pushed msg/console frames, not a reply.
  async function runConsole(node, command, { idleMs = 1200, maxMs = 20_000 } = {}) {
    const msgs = await client.collectMessages(
      (m) => m.action === 'msg' && m.type === 'console' && m.nodeid === node._id,
      async () => {
        const res = await client.sendCommand(
          { action: 'runcommands', nodeids: [node._id], cmds: command, type: 4, reply: true },
          15_000
        );
        if (isServerError(res)) throw new Error(`MeshCentral: ${res.result}`);
      },
      { idleMs, maxMs, firstMs: 10_000 }
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

  // ════════════════════════════════════════════════════════════════════════
  // R — inventory & monitoring
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_server_info', tier: 'R', title: 'Server info',
    description: 'MeshCentral server information gathered at connect (name, version, features).',
    handler: async () => {
      if (client.serverInfo) return textResult(client.serverInfo);
      return errorResult('Server info not yet available (still connecting).');
    },
  });

  define({
    name: 'mesh_list_groups', tier: 'R', title: 'List device groups',
    description: 'List all device groups (meshes): names, types, and IDs.',
    handler: async () => serverResult(await client.sendCommand({ action: 'meshes' }, 15_000)),
  });

  define({
    name: 'mesh_list_devices', tier: 'R', title: 'List devices',
    description: 'List devices (nodes), optionally filtered by device group name or ID.',
    schema: { group_id: z.string().optional().describe('Device group ID or name to filter by') },
    handler: async ({ group_id }) => {
      const cmd = { action: 'nodes' };
      if (group_id) cmd[group_id.includes('/') ? 'meshid' : 'meshname'] = group_id;
      return serverResult(await client.sendCommand(cmd, 20_000));
    },
  });

  define({
    name: 'mesh_get_device', tier: 'R', title: 'Get device',
    description: 'Get details for one device by node ID or name.',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) => {
      const node = await getNode(node_id);
      if (!node) return errorResult(`No device matching '${node_id}'`);
      return textResult(node);
    },
  });

  define({
    name: 'mesh_list_users', tier: 'R', title: 'List users',
    description: 'List all user accounts on the server.',
    handler: async () => serverResult(await client.sendCommand({ action: 'users' }, 15_000)),
  });

  define({
    name: 'mesh_list_user_groups', tier: 'R', title: 'List user groups',
    description: 'List all user groups.',
    handler: async () => serverResult(await client.sendCommand({ action: 'usergroups' }, 15_000)),
  });

  define({
    name: 'mesh_get_events', tier: 'R', title: 'Get events',
    description: 'Recent audit events, optionally filtered by device or user.',
    schema: {
      node_id: z.string().optional().describe('Filter by device node ID'),
      userid: z.string().optional().describe('Filter by user ID'),
      limit: z.number().int().positive().optional().describe('Max events (default 50)'),
    },
    handler: async ({ node_id, userid, limit }) => {
      const cmd = { action: 'events' };
      if (node_id) cmd.nodeid = await resolveNodeId(node_id);
      if (userid) cmd.userid = userid;
      if (limit) cmd.limit = limit;
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_get_notes', tier: 'R', title: 'Get device notes',
    description: 'Get the notes/description attached to a device.',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) => serverResult(await client.sendCommand({ action: 'getNotes', id: await resolveNodeId(node_id) }, 10_000)),
  });

  define({
    name: 'mesh_get_lastconnects', tier: 'R', title: 'Last connection times',
    description: 'Last connection time for every device the account can see.',
    handler: async () => serverResult(await client.sendCommand({ action: 'lastconnects' }, 15_000)),
  });

  define({
    name: 'mesh_get_power_timeline', tier: 'R', title: 'Power timeline',
    description: 'Power-state history (on/off/sleep) for a device.',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) => serverResult(await client.sendCommand({ action: 'powertimeline', nodeid: await resolveNodeId(node_id) }, 15_000)),
  });

  define({
    name: 'mesh_get_sysinfo', tier: 'R', title: 'System info',
    description: 'Stored hardware/system info for a device (CPU, RAM, disks, BIOS, OS, Defender).',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) => serverResult(await client.sendCommand({ action: 'getsysinfo', nodeid: await resolveNodeId(node_id) }, 20_000)),
  });

  define({
    name: 'mesh_get_network_info', tier: 'R', title: 'Network info',
    description: 'Network interface info for a device (MACs, IPs, gateways, DNS, WiFi).',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) => serverResult(await client.sendCommand({ action: 'getnetworkinfo', nodeid: await resolveNodeId(node_id) }, 15_000)),
  });

  define({
    name: 'mesh_server_version', tier: 'R', title: 'Server version',
    description: 'Server version and available update tags.',
    handler: async () => serverResult(await client.sendCommand({ action: 'serverversion' }, 15_000)),
  });

  define({
    name: 'mesh_server_stats', tier: 'R', title: 'Server stats',
    description: 'Server statistics (memory, CPU, connection counts). One snapshot.',
    handler: async () => {
      const res = await client.collectMessages(
        (m) => m.action === 'serverstats' && m.totalmem !== undefined,
        () => client.sendRaw({ action: 'serverstats', interval: 1000 }),
        { idleMs: 200, firstMs: 15_000, maxMs: 16_000 }
      );
      await client.sendRaw({ action: 'serverstats' }).catch(() => {}); // stop the push timer
      if (!res.length) return errorResult('No server stats returned (needs server admin rights).');
      return textResult(res[0]);
    },
  });

  define({
    name: 'mesh_traffic_stats', tier: 'R', title: 'Traffic stats',
    description: 'Server network traffic statistics.',
    handler: async () => serverResult(await client.sendCommand({ action: 'trafficstats' }, 15_000)),
  });

  define({
    name: 'mesh_server_errors', tier: 'R', title: 'Server error log',
    description: 'Server error log.',
    handler: async () => serverResult(await client.sendCommand({ action: 'servererrors' }, 15_000)),
  });

  define({
    name: 'mesh_list_processes', tier: 'R', title: 'List processes',
    description: 'Running processes on a device (via the agent process list).',
    schema: { node_id: z.string().describe('Device node ID or name (must be online)') },
    handler: async ({ node_id }) => {
      const id = await resolveNodeId(node_id);
      const msgs = await client.collectMessages(
        (m) => m.action === 'msg' && m.type === 'ps' && m.nodeid === id,
        () => client.sendRaw({ action: 'msg', type: 'ps', nodeid: id }),
        { idleMs: 500, firstMs: 15_000, maxMs: 20_000 }
      );
      if (!msgs.length) return errorResult('No process list returned (device offline or no access).');
      let value = msgs[msgs.length - 1].value;
      try { value = JSON.parse(value); } catch {}
      return deviceResult(value, 'Process list:');
    },
  });

  // ════════════════════════════════════════════════════════════════════════
  // RF — remote data read
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_get_device_info', tier: 'RF', title: 'Device agent info',
    description: 'Live system summary from the device agent (OS, hardware, network).',
    schema: { node_id: z.string().describe('Device node ID or name (must be online)') },
    handler: async ({ node_id }) => {
      const node = await getNode(node_id);
      if (!node) return errorResult(`No device matching '${node_id}'`);
      const out = await runConsole(node, 'sysinfo');
      return deviceResult(out || '(no response from agent)', `Agent info for ${node.name}:`);
    },
  });

  define({
    name: 'mesh_list_software', tier: 'RF', title: 'List software',
    description:
      'Installed software on a device. Runs a read-only OS-appropriate inventory command through the agent ' +
      '(the native MeshCentral software action is broken on some server versions and is not used).',
    schema: { node_id: z.string().describe('Device node ID or name (must be online)') },
    handler: async ({ node_id }) => {
      const node = await getNode(node_id);
      if (!node) return errorResult(`No device matching '${node_id}'`);
      const win = isWindowsNode(node);
      const cmd = win
        ? "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, " +
          "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* " +
          "| Where-Object DisplayName | Select-Object DisplayName,DisplayVersion | Sort-Object DisplayName | Format-Table -AutoSize | Out-String"
        : "(command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Package} ${Version}\\n') || (command -v rpm >/dev/null 2>&1 && rpm -qa) || echo 'No supported package manager found'";
      const out = await runShell(node, cmd, win ? 2 : 3, 40_000);
      return deviceResult(out, `Installed software on ${node.name}:`);
    },
  });

  define({
    name: 'mesh_get_clipboard', tier: 'RF', title: 'Get clipboard',
    description: 'Read the clipboard contents of a device (agent must be online; empty clipboard returns nothing).',
    schema: { node_id: z.string().describe('Device node ID or name (must be online)') },
    handler: async ({ node_id }) => {
      const id = await resolveNodeId(node_id);
      client.sendRaw({ action: 'msg', type: 'getclip', nodeid: id, tag: 3 }).catch(() => {});
      try {
        const res = await client.waitForMessage(
          (m) => m.action === 'msg' && m.type === 'getclip' && m.nodeid === id && m.data !== undefined,
          15_000
        );
        return deviceResult(res.data, 'Clipboard:');
      } catch {
        return errorResult('No clipboard data returned (clipboard empty, no desktop session, or clipboard module missing).');
      }
    },
  });

  // ── File reads (RF) ──────────────────────────────────────────────────────
  define({
    name: 'mesh_file_list', tier: 'RF', title: 'List remote files',
    description: 'List files and folders on a device.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Directory path (e.g. "C:\\\\" on Windows, "/" on Linux)'),
    },
    handler: async ({ node_id, path: dirPath }) =>
      deviceResult(await withFileTunnel(node_id, (t) => t.list(dirPath)), `Listing of ${dirPath}:`),
  });

  define({
    name: 'mesh_file_read', tier: 'RF', title: 'Read remote file',
    description: 'Read a file from a device. Text is returned inline; binary as base64.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      file_path: z.string().describe('Full path of the file to read'),
      max_kb: z.number().int().positive().optional().describe('Max size to read in KB (default 512, max 2048)'),
    },
    handler: async ({ node_id, file_path, max_kb }) => {
      const maxBytes = Math.min(max_kb ?? 512, 2048) * 1024;
      const data = await withFileTunnel(node_id, (t) => t.download(file_path, { maxBytes }));
      if (data.length === 0) return textResult('(empty file, 0 bytes)');
      const text = data.toString('utf8');
      const printable = [...text].filter((c) => c.charCodeAt(0) >= 9 && c.charCodeAt(0) !== 65533).length / text.length;
      if (printable > 0.95) return deviceResult(text, `${file_path} (${data.length} bytes):`);
      return deviceResult(data.toString('base64'), `${file_path} (BINARY, ${data.length} bytes, base64):`);
    },
  });

  define({
    name: 'mesh_file_download', tier: 'RF', title: 'Download remote file',
    description: 'Download a file from a device to the local file directory on this MCP host.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      remote_path: z.string().describe('Full path of the file on the device'),
      local_path: z.string().describe('Local destination path (confined to MESH_LOCAL_FILE_ROOT)'),
    },
    handler: async ({ node_id, remote_path, local_path }) => {
      const dest = resolveLocalPath(local_path, { mustExist: false });
      const data = await withFileTunnel(node_id, (t) => t.download(remote_path));
      fs.writeFileSync(dest, data);
      return textResult(`Downloaded ${data.length} bytes from ${remote_path} to ${dest}`);
    },
  });

  define({
    name: 'mesh_file_find', tier: 'RF', title: 'Find remote files',
    description: 'Search for files on a device by filename filter.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Directory to search in'),
      filter: z.string().describe('Filename filter (e.g. "*.log")'),
    },
    handler: async ({ node_id, path: dirPath, filter }) =>
      deviceResult(await withFileTunnel(node_id, (t) => t.find(dirPath, filter)), `Search results in ${dirPath} for ${filter}:`),
  });

  // ════════════════════════════════════════════════════════════════════════
  // W — low-impact writes
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_set_notes', tier: 'W', title: 'Set device notes',
    description: 'Set the notes/description on a device.',
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      notes: z.string().describe('Notes text'),
    },
    handler: async ({ node_id, notes }) => {
      await client.sendRaw({ action: 'setNotes', id: await resolveNodeId(node_id), notes });
      return textResult('Notes set (the server does not acknowledge this; verify with mesh_get_notes).');
    },
  });

  define({
    name: 'mesh_edit_device', tier: 'W', title: 'Edit device',
    description: "Edit a device's name, host, tags, consent flags, or RDP/SSH ports.",
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      name: z.string().optional().describe('New display name'),
      host: z.string().optional().describe('New hostname/IP'),
      tags: z.array(z.string()).optional().describe('Tags to set'),
      consent: z.number().int().optional().describe('Consent flags bitmask'),
      rdpport: z.number().int().optional().describe('RDP port'),
      sshport: z.number().int().optional().describe('SSH port'),
    },
    handler: async ({ node_id, ...props }) => {
      const cmd = { action: 'changedevice', nodeid: await resolveNodeId(node_id), ...props };
      if (Array.isArray(cmd.tags)) cmd.tags = JSON.stringify(cmd.tags);
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_create_group', tier: 'W', title: 'Create device group',
    description: 'Create a new device group.',
    schema: {
      name: z.string().describe('Name of the new device group'),
      description: z.string().optional().describe('Optional description'),
      type: z.number().int().optional().describe('1=AMT, 2=Agent (default), 3=Local'),
    },
    handler: async ({ name, description, type }) => {
      const cmd = { action: 'createmesh', meshname: name, meshtype: type ?? 2 };
      if (description) cmd.desc = description;
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_edit_group', tier: 'W', title: 'Edit device group',
    description: 'Edit a device group name or description.',
    schema: {
      mesh_id: z.string().describe('Device group ID or name'),
      name: z.string().optional().describe('New group name'),
      description: z.string().optional().describe('New description'),
    },
    handler: async ({ mesh_id, name, description }) => {
      const cmd = { action: 'editmesh', meshid: meshId(mesh_id) };
      if (name) cmd.meshname = name;
      if (description !== undefined) cmd.desc = description;
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_change_device_group', tier: 'W', title: 'Move device to group',
    description: 'Move a device to a different device group.',
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      meshid: z.string().describe('Target group ID or name'),
    },
    handler: async ({ node_id, meshid }) =>
      serverResult(await client.sendCommand({ action: 'changeDeviceMesh', nodeids: [await resolveNodeId(node_id)], meshid: meshId(meshid) }, 15_000)),
  });

  define({
    name: 'mesh_send_toast', tier: 'W', title: 'Send toast',
    description: 'Send a toast notification to devices.',
    schema: {
      node_ids: z.array(z.string()).describe('Device node IDs or names'),
      message: z.string().describe('Notification message'),
    },
    handler: async ({ node_ids, message }) =>
      serverResult(await client.sendCommand({ action: 'toast', nodeids: await resolveNodeIds(node_ids), msg: message }, 15_000)),
  });

  define({
    name: 'mesh_wake_devices', tier: 'W', title: 'Wake devices',
    description: 'Send Wake-on-LAN to devices.',
    schema: { node_ids: z.array(z.string()).describe('Device node IDs or names to wake') },
    handler: async ({ node_ids }) =>
      serverResult(await client.sendCommand({ action: 'wakedevices', nodeids: await resolveNodeIds(node_ids) }, 15_000)),
  });

  define({
    name: 'mesh_set_clipboard', tier: 'W', title: 'Set clipboard',
    description: 'Set the clipboard contents on a device (agent must be online).',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      data: z.string().describe('Text to place on the clipboard'),
    },
    handler: async ({ node_id, data }) => {
      const id = await resolveNodeId(node_id);
      try {
        const res = await client.collectMessages(
          (m) => m.action === 'msg' && m.type === 'setclip' && m.success !== undefined,
          () => client.sendRaw({ action: 'msg', type: 'setclip', nodeid: id, data }),
          { idleMs: 200, firstMs: 10_000, maxMs: 11_000 }
        );
        if (res.length && res[0].success) return textResult('Clipboard set.');
        return textResult('Clipboard set request sent (device did not confirm; it may lack a desktop session).');
      } catch {
        return textResult('Clipboard set request sent (no confirmation from device).');
      }
    },
  });

  define({
    name: 'mesh_create_invite_link', tier: 'W', title: 'Create invite link',
    description: 'Create an agent-installation invite link for a device group.',
    schema: {
      mesh_id: z.string().describe('Device group ID or name'),
      expire_hours: z.number().int().positive().optional().describe('Expiry in hours (default 8)'),
      flags: z.number().int().optional().describe('Invite flags (0 = installation link)'),
    },
    handler: async ({ mesh_id, expire_hours, flags }) =>
      serverResult(await client.sendCommand({ action: 'createInviteLink', meshid: meshId(mesh_id), expire: expire_hours ?? 8, flags: flags ?? 0 }, 15_000)),
  });

  // ── File metadata writes (W) ─────────────────────────────────────────────
  // These agent file ops are not acknowledged, so each verifies via stat()/list().
  define({
    name: 'mesh_file_mkdir', tier: 'W', title: 'Create remote directory',
    description: 'Create a directory on a device.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Full path of the directory to create'),
    },
    handler: async ({ node_id, path: dirPath }) =>
      withFileTunnel(node_id, async (t) => {
        t.mkdir(dirPath);
        await new Promise((r) => setTimeout(r, 400));
        const entry = await t.stat(dirPath).catch(() => null);
        return entry ? textResult(`Created directory ${dirPath}`) : errorResult(`Could not confirm directory ${dirPath} was created`);
      }),
  });

  define({
    name: 'mesh_file_rename', tier: 'W', title: 'Rename remote file',
    description: 'Rename a file or folder on a device (within its directory).',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Parent directory'),
      old_name: z.string().describe('Current name'),
      new_name: z.string().describe('New name'),
    },
    handler: async ({ node_id, path: dirPath, old_name, new_name }) =>
      withFileTunnel(node_id, async (t) => {
        t.rename(dirPath, old_name, new_name);
        await new Promise((r) => setTimeout(r, 400));
        const entry = await t.stat(joinRemotePath(dirPath, new_name)).catch(() => null);
        return entry ? textResult(`Renamed ${old_name} to ${new_name} in ${dirPath}`) : errorResult(`Could not confirm rename to ${new_name}`);
      }),
  });

  define({
    name: 'mesh_file_copy', tier: 'W', title: 'Copy remote files',
    description: 'Copy files between directories on a device.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      source_dir: z.string().describe('Source directory'),
      dest_dir: z.string().describe('Destination directory'),
      names: z.array(z.string()).describe('File names to copy (relative to source_dir)'),
    },
    handler: async ({ node_id, source_dir, dest_dir, names }) =>
      withFileTunnel(node_id, async (t) => {
        t.copy(source_dir, dest_dir, names);
        await new Promise((r) => setTimeout(r, 500));
        return textResult(`Copy of ${JSON.stringify(names)} from ${source_dir} to ${dest_dir} requested (verify with mesh_file_list).`);
      }),
  });

  define({
    name: 'mesh_file_move', tier: 'W', title: 'Move remote files',
    description: 'Move files between directories on a device.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      source_dir: z.string().describe('Source directory'),
      dest_dir: z.string().describe('Destination directory'),
      names: z.array(z.string()).describe('File names to move (relative to source_dir)'),
    },
    handler: async ({ node_id, source_dir, dest_dir, names }) =>
      withFileTunnel(node_id, async (t) => {
        t.move(source_dir, dest_dir, names);
        await new Promise((r) => setTimeout(r, 500));
        return textResult(`Move of ${JSON.stringify(names)} from ${source_dir} to ${dest_dir} requested (verify with mesh_file_list).`);
      }),
  });

  // ════════════════════════════════════════════════════════════════════════
  // X — remote code execution
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_run_command', tier: 'X', title: 'Run command',
    description: 'Run a shell command on a device and capture its output. type: 0 auto, 1 CMD, 2 PowerShell, 3 Linux/macOS.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, command, type }) => `Run on ${node_id} (type ${type ?? 0}):\n${command}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      command: z.string().describe('Command to execute'),
      type: z.number().int().min(0).max(3).optional().describe('0 auto, 1 CMD, 2 PowerShell, 3 Linux/macOS'),
    },
    handler: async ({ node_id, command, type }) => {
      const node = await getNode(node_id);
      if (!node) return errorResult(`No device matching '${node_id}'`);
      const out = await runShell(node, command, type ?? 0, 60_000);
      return deviceResult(out || '(no output)', `Output from ${node.name}:`);
    },
  });

  define({
    name: 'mesh_agent_console', tier: 'X', title: 'Agent console',
    description: 'Run a MeshAgent console command and capture its output (e.g. "help", "coreinfo", "netinfo", "service").',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, command }) => `Agent console on ${node_id}:\n${command}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      command: z.string().describe('Agent console command'),
    },
    handler: async ({ node_id, command }) => {
      const node = await getNode(node_id);
      if (!node) return errorResult(`No device matching '${node_id}'`);
      const out = await runConsole(node, command);
      return deviceResult(out || '(no response from agent)', `Agent console on ${node.name}:`);
    },
  });

  // ── Interactive terminal (X) ─────────────────────────────────────────────
  const shellList = Object.keys(SHELLS).join(', ');
  define({
    name: 'mesh_terminal_open', tier: 'X', title: 'Open terminal',
    description:
      `Open an interactive terminal session to a device and return a session_id plus the initial screen. ` +
      `Shells: ${shellList}. Use mesh_terminal_input to type, mesh_terminal_read to re-read, mesh_terminal_close to end.`,
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, shell }) => `Open ${shell || 'shell'} terminal on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      shell: z.enum(Object.keys(SHELLS)).optional().describe(`Shell type (default "shell"): ${shellList}`),
      cols: z.number().int().positive().optional().describe('Terminal columns (default 120)'),
      rows: z.number().int().positive().optional().describe('Terminal rows (default 32)'),
    },
    handler: async ({ node_id, shell, cols, rows }) => {
      const session = await terminals.open({ nodeId: await resolveNodeId(node_id), shell: shell ?? 'shell', cols: cols ?? 120, rows: rows ?? 32 });
      await waitForOutput(session, { quietMs: 700, maxMs: 8_000 });
      return deviceResult(session.screen(), `Terminal opened. session_id=${session.id} shell=${session.shell}\nInitial screen:`);
    },
  });

  define({
    name: 'mesh_terminal_input', tier: 'X', title: 'Terminal input',
    description:
      'Send input to an open terminal session and return the new output. By default a carriage return is appended ' +
      '(submit=true), so `input` is run as a command line. Set submit=false to send raw keys (e.g. control sequences).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, input }) => `Send to terminal ${session_id}:\n${input}`,
    schema: {
      session_id: z.string().describe('Session ID from mesh_terminal_open'),
      input: z.string().describe('Text to send'),
      submit: z.boolean().optional().describe('Append a carriage return (default true)'),
      wait_ms: z.number().int().positive().optional().describe('Max ms to wait for output to settle (default 15000)'),
    },
    handler: async ({ session_id, input, submit, wait_ms }) => {
      const session = terminals.get(session_id);
      if (!session.isOpen) return errorResult(`Terminal ${session_id} is closed (${session.closedReason || 'unknown'}).`);
      const before = session.renderedLines();
      session.send(submit === false ? input : input + '\r');
      await waitForOutput(session, { quietMs: 800, maxMs: wait_ms ?? 15_000 });
      const after = session.renderedLines();

      // Return the rendered-screen delta: the lines appended since the input. xterm
      // has already collapsed interactive redraws, so this is clean for CMD, bash,
      // and PowerShell/PSReadLine alike. Back up one line to include the prompt the
      // command was typed on, for context.
      const limit = Math.min(before.length, after.length);
      let common = 0;
      while (common < limit && before[common] === after[common]) common++;
      if (common > 0) common -= 1;
      const delta = after.slice(common).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      return deviceResult(delta || '(no new output)', `Terminal ${session_id} output:`);
    },
  });

  define({
    name: 'mesh_terminal_read', tier: 'R', title: 'Read terminal',
    description: 'Re-read an open terminal session without sending input. mode "screen" (current view) or "transcript" (full scrollback).',
    schema: {
      session_id: z.string().describe('Session ID from mesh_terminal_open'),
      mode: z.enum(['screen', 'transcript']).optional().describe('Default "screen"'),
    },
    handler: async ({ session_id, mode }) => {
      const session = terminals.get(session_id);
      const text = mode === 'transcript' ? session.transcript() : session.screen();
      return deviceResult(text, `Terminal ${session_id} (${mode || 'screen'})${session.isOpen ? '' : ' [CLOSED]'}:`);
    },
  });

  define({
    name: 'mesh_terminal_list', tier: 'R', title: 'List terminals',
    description: 'List open terminal sessions managed by this server.',
    handler: async () => textResult(terminals.list()),
  });

  define({
    name: 'mesh_terminal_close', tier: 'X', title: 'Close terminal',
    description: 'Close an open terminal session.',
    schema: { session_id: z.string().describe('Session ID from mesh_terminal_open') },
    handler: async ({ session_id }) => {
      const session = terminals.get(session_id);
      session.close('closed by user');
      return textResult(`Terminal ${session_id} closed.`);
    },
  });

  // ── Remote desktop (KVM) ──────────────────────────────────────────────────
  // Screenshot is RF (remote view). Opening a control session and sending input
  // are X (remote control of the console).
  define({
    name: 'mesh_desktop_screenshot', tier: 'RF', title: 'Desktop screenshot',
    description:
      'Capture a screenshot of a device desktop as a JPEG image. Pass session_id to grab the current frame of an ' +
      'open session, or node_id to take a one-off capture. Returns the image plus its native pixel dimensions.',
    schema: {
      node_id: z.string().optional().describe('Device node ID or name (for a one-off capture; must be online)'),
      session_id: z.string().optional().describe('Open desktop session to re-capture instead'),
      display: z.number().int().optional().describe('Display/monitor number to capture (one-off only; 65535 = all). Omit for the current one.'),
      max_width: z.number().int().positive().optional().describe('Downscale so width <= this (default 1280; use native width to disable)'),
    },
    handler: async ({ node_id, session_id, display, max_width }) => {
      const maxWidth = max_width ?? 1280;
      if (session_id) {
        const s = desktops.get(session_id);
        await s.capture({ maxMs: 8_000 }); // burst if idle-paused; freshen if live
        if (!s.hasFrame()) return errorResult('No frame available for that session yet.');
        return imageResult(s.encodeJpeg({ maxWidth }), `Desktop (session ${session_id}):`, s);
      }
      if (!node_id) return errorResult('Provide node_id (one-off) or session_id (open session).');
      const enc = await desktops.screenshot(await resolveNodeId(node_id), { maxWidth, display });
      return imageResult(enc, `Desktop of ${node_id}:`);
    },
  });

  define({
    name: 'mesh_desktop_open', tier: 'X', title: 'Open desktop session',
    description:
      'Open an interactive remote-desktop (KVM) session to a device console and return a session_id plus the first ' +
      'screenshot. Use mesh_desktop_click / _type / _key / _scroll to control it, mesh_desktop_screenshot to re-capture.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id }) => `Open remote desktop control of ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      display: z.number().int().optional().describe('Display/monitor number to view (65535 = all). Omit for the primary.'),
      stream: z.enum(['auto', 'live', 'idle']).optional().describe(
        'Video mode. "auto" (default): pause the device stream between captures, but stay live while a human is also ' +
        'watching this KVM. "live": always stream continuously (for simultaneous human viewing). "idle": always pause between captures.'
      ),
    },
    handler: async ({ node_id, display, stream }) => {
      const session = await desktops.open(await resolveNodeId(node_id), { streamMode: stream ?? 'auto' });
      await waitForFrame(session, { requireNew: false, maxMs: 10_000 });
      if (display != null) { session.setDisplay(display); await waitForFrame(session, { maxMs: 6_000 }); }
      if (!session.hasFrame()) {
        session.close('no frame');
        return errorResult('Desktop session opened but no frame was captured (no active console session, or view denied).');
      }
      session.maybePause(); // warm session; keep streaming only if live/co-viewed
      return imageResult(session.encodeJpeg({ maxWidth: 1280 }), `Desktop session opened. session_id=${session.id} (stream=${session.streamMode})`, session);
    },
  });

  // Let the input land, then stream one full frame (unpause→refresh→settle→re-pause)
  // so the model sees the effect without the device streaming while idle.
  async function afterInput(session, settle) {
    await new Promise((r) => setTimeout(r, 150)); // let the input reach the OS before we repaint
    await session.capture({ minMs: settle, settleMs: 650, maxMs: settle + 6_000 });
    return session.encodeJpeg({ maxWidth: 1280 });
  }

  define({
    name: 'mesh_desktop_click', tier: 'X', title: 'Desktop click',
    description: 'Click (or double-click) at native pixel coordinates in a desktop session, then return a fresh screenshot.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, x, y, button }) => `${button || 'left'}-click at (${x},${y}) in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID from mesh_desktop_open'),
      x: z.number().int().min(0).describe('X in native pixels'),
      y: z.number().int().min(0).describe('Y in native pixels'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
      double: z.boolean().optional().describe('Double-click'),
    },
    handler: async ({ session_id, x, y, button, double }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      await s.click(x, y, button ?? 'left', double ?? false);
      return imageResult(await afterInput(s, 1500), `After ${double ? 'double-' : ''}${button ?? 'left'}-click at (${x},${y}):`);
    },
  });

  define({
    name: 'mesh_desktop_move', tier: 'X', title: 'Desktop mouse move',
    description: 'Move the mouse to native pixel coordinates (no click).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, x, y }) => `Move mouse to (${x},${y}) in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID'),
      x: z.number().int().min(0), y: z.number().int().min(0),
    },
    handler: async ({ session_id, x, y }) => {
      const s = desktops.get(session_id);
      s.move(x, y);
      return textResult(`Moved to (${x},${y}).`);
    },
  });

  define({
    name: 'mesh_desktop_type', tier: 'X', title: 'Desktop type text',
    description: 'Type a string into the desktop session (sent as Unicode key events), then return a screenshot.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, text }) => `Type into desktop ${session_id}: ${text}`,
    schema: {
      session_id: z.string().describe('Session ID'),
      text: z.string().describe('Text to type'),
    },
    handler: async ({ session_id, text }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      s.typeText(text);
      return imageResult(await afterInput(s, 1200), `After typing ${JSON.stringify(text)}:`);
    },
  });

  define({
    name: 'mesh_desktop_key', tier: 'X', title: 'Desktop key press',
    description: `Press a special key by name (then screenshot). Known: ${Object.keys(VK).join(', ')}.`,
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, key }) => `Press ${key} in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID'),
      key: z.string().describe('Key name (e.g. enter, tab, escape, win, f5, up)'),
    },
    handler: async ({ session_id, key }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      const { vk, extended } = vkFor(key);
      if (vk == null) return errorResult(`Unknown key '${key}'. Known: ${Object.keys(VK).join(', ')}`);
      s.keyVk(vk, extended);
      return imageResult(await afterInput(s, 1000), `After pressing ${key}:`);
    },
  });

  define({
    name: 'mesh_desktop_hotkey', tier: 'X', title: 'Desktop hotkey',
    description:
      'Press a key chord in a desktop session (modifiers held while the final key is pressed), then screenshot. ' +
      'Give keys in order, e.g. ["ctrl","s"], ["alt","f4"], ["ctrl","shift","escape"], ["win","d"]. ' +
      'Modifiers: ctrl, alt, shift, win. Other keys: single characters or names (enter, tab, f4, delete, ...).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, keys }) => `Press ${keys.join('+')} in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID'),
      keys: z.array(z.string()).min(1).describe('Keys in press order; modifiers first (e.g. ["ctrl","s"])'),
    },
    handler: async ({ session_id, keys }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      const specs = keys.map((k) => ({ name: k, ...vkFor(k) }));
      const bad = specs.filter((x) => x.vk == null).map((x) => x.name);
      if (bad.length) return errorResult(`Unknown key(s): ${bad.join(', ')}`);
      s.hotkey(specs);
      return imageResult(await afterInput(s, 1200), `After ${keys.join('+')}:`, s);
    },
  });

  define({
    name: 'mesh_desktop_scroll', tier: 'X', title: 'Desktop scroll',
    description: 'Scroll the mouse wheel at native pixel coordinates (positive = up), then screenshot.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, amount }) => `Scroll ${amount} in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID'),
      x: z.number().int().min(0), y: z.number().int().min(0),
      amount: z.number().int().describe('Wheel delta (positive = up, negative = down; e.g. 360)'),
    },
    handler: async ({ session_id, x, y, amount }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      s.scroll(x, y, amount);
      return imageResult(await afterInput(s, 1000), `After scroll ${amount} at (${x},${y}):`);
    },
  });

  define({
    name: 'mesh_desktop_set_display', tier: 'X', title: 'Select desktop monitor',
    description: 'Switch which monitor an open desktop session shows (use the display numbers from a screenshot; 65535 = all).',
    schema: {
      session_id: z.string().describe('Session ID'),
      display: z.number().int().describe('Display/monitor number (65535 = all)'),
    },
    handler: async ({ session_id, display }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      s.setDisplay(display);
      await s.capture({ maxMs: 6_000 });
      return imageResult(s.encodeJpeg({ maxWidth: 1280 }), `Switched to display ${display}:`, s);
    },
  });

  define({
    name: 'mesh_desktop_set_stream', tier: 'X', title: 'Set desktop stream mode',
    description:
      'Change a session\'s video mode. "live" keeps the device streaming continuously (for a human watching the same ' +
      'session alongside the agent); "idle" pauses between captures to save bandwidth; "auto" stays live only while ' +
      'another viewer is attached.',
    schema: {
      session_id: z.string().describe('Session ID'),
      mode: z.enum(['auto', 'live', 'idle']).describe('Video mode'),
    },
    handler: async ({ session_id, mode }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      s.setStreamMode(mode);
      return textResult(`Desktop ${session_id} stream mode set to ${s.streamMode} (viewers attached: ${s.viewers}, currently ${s.paused ? 'paused' : 'live'}).`);
    },
  });

  define({
    name: 'mesh_desktop_list', tier: 'R', title: 'List desktop sessions',
    description: 'List open remote-desktop sessions.',
    handler: async () => textResult(desktops.list()),
  });

  define({
    name: 'mesh_desktop_close', tier: 'X', title: 'Close desktop session',
    description: 'Close an open remote-desktop session.',
    schema: { session_id: z.string().describe('Session ID') },
    handler: async ({ session_id }) => {
      desktops.get(session_id).close('closed by user');
      return textResult(`Desktop ${session_id} closed.`);
    },
  });

  // ════════════════════════════════════════════════════════════════════════
  // WF — remote file write / destruction
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_file_write', tier: 'WF', title: 'Write remote file',
    description: 'Write text or base64 content to a file on a device.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, file_path }) => `Write file ${file_path} on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      file_path: z.string().describe('Full destination path on the device'),
      content: z.string().describe('Content to write'),
      encoding: z.enum(['utf8', 'base64']).optional().describe('Content encoding (default utf8)'),
    },
    handler: async ({ node_id, file_path, content, encoding }) => {
      const data = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
      const { dir, name } = splitRemotePath(file_path);
      await withFileTunnel(node_id, (t) => t.upload(dir, name, data));
      return textResult(`Wrote ${data.length} bytes to ${file_path}`);
    },
  });

  define({
    name: 'mesh_file_upload', tier: 'WF', title: 'Upload file to device',
    description: 'Upload a local file (from MESH_LOCAL_FILE_ROOT) to a device.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ local_path, node_id, remote_dir }) => `Upload ${local_path} to ${remote_dir} on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      local_path: z.string().describe('Local file to upload (confined to MESH_LOCAL_FILE_ROOT)'),
      remote_dir: z.string().describe('Destination directory on the device'),
      remote_name: z.string().optional().describe('Destination filename (default: same as local)'),
    },
    handler: async ({ node_id, local_path, remote_dir, remote_name }) => {
      const src = resolveLocalPath(local_path, { mustExist: true });
      const data = fs.readFileSync(src);
      const name = remote_name || splitRemotePath(src).name;
      await withFileTunnel(node_id, (t) => t.upload(remote_dir, name, data));
      return textResult(`Uploaded ${src} (${data.length} bytes) to ${joinRemotePath(remote_dir, name)}`);
    },
  });

  define({
    name: 'mesh_file_delete', tier: 'WF', title: 'Delete remote files',
    description: 'Delete files or folders on a device.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, path, names, recursive }) =>
      `Delete ${JSON.stringify(names)} from ${path} on ${node_id}${recursive ? ' (recursive)' : ''}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Parent directory containing the files'),
      names: z.array(z.string()).describe('File/folder names to delete (relative to path)'),
      recursive: z.boolean().optional().describe('Recursive delete for folders (default false)'),
    },
    handler: async ({ node_id, path: dirPath, names, recursive }) =>
      withFileTunnel(node_id, async (t) => {
        t.delete(dirPath, names, recursive ?? false);
        await new Promise((r) => setTimeout(r, 500));
        const remaining = await t.list(dirPath).then((d) => d.map((e) => e.n)).catch(() => null);
        if (remaining) {
          const left = names.filter((n) => remaining.includes(n));
          if (left.length) return errorResult(`Delete requested, but still present: ${JSON.stringify(left)}`);
        }
        return textResult(`Deleted ${JSON.stringify(names)} from ${dirPath}`);
      }),
  });

  // ════════════════════════════════════════════════════════════════════════
  // P — disruptive / agent lifecycle
  // ════════════════════════════════════════════════════════════════════════

  const POWER_MAP = { sleep: 3, reset: 4, poweroff: 2, flash: 400, vibrate: 401 };
  define({
    name: 'mesh_power_action', tier: 'P', title: 'Power action',
    description: 'Send a power action to devices: sleep, reset, poweroff, flash, vibrate.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_ids, action }) => `Power action "${action}" on ${JSON.stringify(node_ids)}`,
    schema: {
      node_ids: z.array(z.string()).describe('Device node IDs or names'),
      action: z.enum(['sleep', 'reset', 'poweroff', 'flash', 'vibrate']).describe('Power action'),
    },
    handler: async ({ node_ids, action }) =>
      serverResult(await client.sendCommand({ action: 'poweraction', nodeids: await resolveNodeIds(node_ids), actiontype: POWER_MAP[action] }, 15_000)),
  });

  define({
    name: 'mesh_kill_process', tier: 'P', title: 'Kill process',
    description: 'Kill a process on a device by PID (via the agent process manager).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, pid }) => `Kill PID ${pid} on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      pid: z.number().int().positive().describe('Process ID to kill'),
    },
    handler: async ({ node_id, pid }) => {
      await client.sendRaw({ action: 'msg', type: 'pskill', nodeid: await resolveNodeId(node_id), value: String(pid) });
      return textResult(`Kill requested for PID ${pid} (verify with mesh_list_processes).`);
    },
  });

  define({
    name: 'mesh_remove_device', tier: 'P', title: 'Remove device',
    description: 'Remove/delete a device from MeshCentral.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id }) => `Remove device ${node_id}`,
    schema: { node_id: z.string().describe('Device node ID or name to remove') },
    handler: async ({ node_id }) =>
      serverResult(await client.sendCommand({ action: 'removedevices', nodeids: [await resolveNodeId(node_id)] }, 15_000)),
  });

  define({
    name: 'mesh_uninstall_agent', tier: 'P', title: 'Uninstall agent',
    description: 'Uninstall the MeshAgent from a device.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id }) => `Uninstall agent from ${node_id}`,
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) =>
      serverResult(await client.sendCommand({ action: 'uninstallagent', nodeids: [await resolveNodeId(node_id)] }, 15_000)),
  });

  define({
    name: 'mesh_distribute_core', tier: 'P', title: 'Distribute agent core',
    description: 'Push an agent core to devices (default, clear, recovery, tiny).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_ids, type }) => `Push "${type}" core to ${JSON.stringify(node_ids)}`,
    schema: {
      node_ids: z.array(z.string()).describe('Device node IDs or names'),
      type: z.enum(['default', 'clear', 'recovery', 'tiny']).describe('Core type'),
    },
    handler: async ({ node_ids, type }) => {
      await client.sendRaw({ action: 'uploadagentcore', nodeids: await resolveNodeIds(node_ids), type });
      return textResult(`Core '${type}' distribution requested for ${node_ids.length} device(s).`);
    },
  });

  define({
    name: 'mesh_update_agents', tier: 'P', title: 'Update agents',
    description: 'Request a device agent to update to the latest version.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id }) => `Update agent on ${node_id}`,
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) => {
      await client.sendRaw({ action: 'updateAgents', nodeids: [await resolveNodeId(node_id)] });
      return textResult('Agent update requested.');
    },
  });

  define({
    name: 'mesh_delete_group', tier: 'P', title: 'Delete device group',
    description: 'Delete a device group.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ meshid }) => `Delete device group ${meshid}`,
    schema: { meshid: z.string().describe('The mesh/group ID or name to delete') },
    handler: async ({ meshid }) => serverResult(await client.sendCommand({ action: 'deletemesh', meshid: meshId(meshid) }, 15_000)),
  });

  // ════════════════════════════════════════════════════════════════════════
  // A — estate / IAM administration
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_create_user', tier: 'A', title: 'Create user',
    description: 'Create a new user account.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ username }) => `Create user "${username}"`,
    schema: {
      username: z.string().describe('Username'),
      password: z.string().describe('Password'),
      email: z.string().optional().describe('Email address'),
      realname: z.string().optional().describe('Real name'),
    },
    handler: async ({ username, password, email, realname }) => {
      const cmd = { action: 'adduser', username, pass: password };
      if (email) cmd.email = email;
      if (realname) cmd.realname = realname;
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_delete_user', tier: 'A', title: 'Delete user',
    description: 'Delete a user account.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ userid }) => `Delete user ${userid}`,
    schema: { userid: z.string().describe('User ID (e.g. "user/domain/username")') },
    handler: async ({ userid }) => serverResult(await client.sendCommand({ action: 'deleteuser', userid }, 15_000)),
  });

  define({
    name: 'mesh_add_user_to_group', tier: 'A', title: 'Grant group access',
    description:
      'Grant a user rights to a device group. Rights bitmask: 1 editGroup, 2 manageUsers, 4 manageComputers, ' +
      '8 remoteControl, 16 agentConsole, 32 remoteCommands, 64 resetPowerOff, 128 viewOnly, 256 noTerminal, ' +
      '512 noDesktop, 1024 noFiles, 2048 noAMT, 4096 limitedInput, 8192 noClipboard, 16384 chat, 32768 wol, ' +
      '65536 noRemoteCmd. 4294967295 = full.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ user_id, mesh_id, rights }) => `Grant ${user_id} rights ${rights} on group ${mesh_id}`,
    schema: {
      user_id: z.string().describe('User ID or username'),
      mesh_id: z.string().describe('Device group ID or name'),
      rights: z.number().int().describe('Rights bitmask (4294967295 = full)'),
    },
    handler: async ({ user_id, mesh_id, rights }) =>
      serverResult(await client.sendCommand({ action: 'addmeshuser', meshid: meshId(mesh_id), userids: [user_id], meshadmin: rights }, 15_000)),
  });

  define({
    name: 'mesh_remove_user_from_group', tier: 'A', title: 'Revoke group access',
    description: "Remove a user's access to a device group.",
    annotations: { destructiveHint: true },
    confirmSummary: ({ user_id, mesh_id }) => `Revoke ${user_id} from group ${mesh_id}`,
    schema: {
      user_id: z.string().describe('User ID or username'),
      mesh_id: z.string().describe('Device group ID or name'),
    },
    handler: async ({ user_id, mesh_id }) =>
      serverResult(await client.sendCommand({ action: 'removemeshuser', meshid: meshId(mesh_id), userid: user_id }, 15_000)),
  });

  define({
    name: 'mesh_add_device_user', tier: 'A', title: 'Grant device access',
    description: 'Grant or remove a user a direct link to one device. Rights bits 0-2 are not allowed on device links.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ user_id, node_id, remove }) => `${remove ? 'Remove' : 'Grant'} ${user_id} access to device ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      user_id: z.string().describe('User ID or username'),
      rights: z.number().int().describe('Rights bitmask'),
      remove: z.boolean().optional().describe('Set true to remove the link'),
    },
    handler: async ({ node_id, user_id, rights, remove }) =>
      serverResult(await client.sendCommand({ action: 'adddeviceuser', nodeid: await resolveNodeId(node_id), userids: [user_id], rights, ...(remove ? { remove: true } : {}) }, 15_000)),
  });

  define({
    name: 'mesh_create_user_group', tier: 'A', title: 'Create user group',
    description: 'Create a user group.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ name }) => `Create user group "${name}"`,
    schema: {
      name: z.string().describe('User group name'),
      description: z.string().optional().describe('Description'),
    },
    handler: async ({ name, description }) => {
      const cmd = { action: 'createusergroup', name };
      if (description) cmd.desc = description;
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_delete_user_group', tier: 'A', title: 'Delete user group',
    description: 'Delete a user group.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ ugrp_id }) => `Delete user group ${ugrp_id}`,
    schema: { ugrp_id: z.string().describe('User group ID (ugrp/...)') },
    handler: async ({ ugrp_id }) => serverResult(await client.sendCommand({ action: 'deleteusergroup', ugrpid: ugrp_id }, 15_000)),
  });

  define({
    name: 'mesh_scan_amt', tier: 'A', title: 'Scan Intel AMT',
    description: 'Scan a network range for Intel AMT devices.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ iprange }) => `Scan ${iprange} for Intel AMT`,
    schema: { iprange: z.string().describe('IP range (e.g. "192.168.1.0/24")') },
    handler: async ({ iprange }) => serverResult(await client.sendCommand({ action: 'scanamtdevice', iprange }, 30_000)),
  });

  define({
    name: 'mesh_server_console', tier: 'A', title: 'Server console',
    description: 'Run a server console command (e.g. "help", "dbstats", "usersessions", "certexpire").',
    annotations: { destructiveHint: true },
    confirmSummary: ({ command }) => `Server console: ${command}`,
    schema: { command: z.string().describe('Server console command') },
    handler: async ({ command }) => serverResult(await client.sendCommand({ action: 'serverconsole', value: command }, 20_000)),
  });

  return { registered, terminals, desktops };
}
