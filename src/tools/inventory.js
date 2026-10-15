import { z } from 'zod';
import { textResult, deviceResult, serverResult, errorResult, isServerError } from '../safety.js';

// R — inventory & monitoring
export default function register(ctx) {
  const {
    define, client, audit, allMeshes, processList, requireNode, resolveNodeId, withStatus, lastConnect, lastConnects, deviceEvents,
  } = ctx;

  // One line of a device's MeshCentral event log.
  const RUN_TYPES = { 0: 'auto', 1: 'CMD', 2: 'PowerShell', 3: 'shell' };
  function formatEvent(e) {
    const when = e.time ? new Date(e.time).toISOString().replace('T', ' ').slice(0, 16) : '?';
    let msg = String(e.msg ?? '').replace(/\s+/g, ' ');
    if (e.action === 'runcommands' && e.cmds) {
      const cmds = String(e.cmds).replace(/\s+/g, ' ');
      msg = `Ran [${RUN_TYPES[e.cmdType] ?? e.cmdType ?? '?'}]: ${cmds.length > 300 ? cmds.slice(0, 300) + '…' : cmds}`;
    }
    return `${when} | ${e.username ?? e.userid ?? 'server'} | ${e.action ?? 'event'} | ${msg}`;
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
    description:
      'List devices with group, OS, online/connection status, and last-connected time (compact). Optionally filter ' +
      'by device group, name substring, or online state. detail=true returns the full MeshCentral device records.',
    schema: {
      group_id: z.string().optional().describe('Device group ID or name to filter by'),
      name: z.string().optional().describe('Only devices whose name contains this (case-insensitive)'),
      online: z.boolean().optional().describe('true = only online devices, false = only offline'),
      detail: z.boolean().optional().describe('Return full device records instead of the compact summary'),
    },
    handler: async ({ group_id, name, online, detail }) => {
      const cmd = { action: 'nodes' };
      if (group_id) cmd[group_id.includes('/') ? 'meshid' : 'meshname'] = group_id;
      const res = await client.sendCommand(cmd, 30_000);
      if (isServerError(res)) return serverResult(res);
      const [meshes, last] = await Promise.all([allMeshes().catch(() => []), lastConnects()]);
      const groupName = (id) => meshes.find((m) => m._id === id)?.name ?? id;
      const needle = name?.toLowerCase();
      const devices = [];
      for (const [meshid, nodes] of Object.entries(res?.nodes ?? {})) {
        for (const n of Array.isArray(nodes) ? nodes : []) {
          const d = withStatus(n, last[n._id] ? { time: last[n._id] } : null);
          if (needle && !String(n.name).toLowerCase().includes(needle)) continue;
          if (online != null && d.online !== online) continue;
          devices.push(detail ? { group: groupName(meshid), ...d } : {
            name: n.name,
            group: groupName(meshid),
            os: n.osdesc ?? null,
            online: d.online,
            ...(d.online ? {} : { last_connected: d.last_connected_ago ?? 'unknown' }),
            ...(n.host || n.ip ? { address: n.host || n.ip } : {}),
            ...(n.tags?.length ? { tags: n.tags } : {}),
            id: n._id,
          });
        }
      }
      devices.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      const on = devices.filter((d) => d.online).length;
      return textResult({ count: devices.length, online: on, offline: devices.length - on, devices });
    },
  });

  define({
    name: 'mesh_get_device', tier: 'R', title: 'Get device',
    description:
      'Get details for one device by node ID or name (case-insensitive, partial names work if unique), including ' +
      'whether its agent is online ("online", "connection", "power") and when it last connected. Use this, not a ' +
      'command, to check if a device or agent is up.',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) => {
      const node = await requireNode(node_id);
      return textResult(withStatus(node, await lastConnect(node._id)));
    },
  });

  define({
    name: 'mesh_device_history', tier: 'R', title: 'Device history',
    description:
      "A device's history from MeshCentral's event log as a compact timeline (newest first): commands run, terminal " +
      'and desktop sessions, agent connects, changes, and notes recorded by technicians or by this server ' +
      '("[MCP]" entries, see mesh_log_event), plus the device notes. Read this before diagnosing a device - it shows ' +
      'what was found and done in earlier sessions.',
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      limit: z.number().int().positive().max(1000).optional().describe('Max events (default 40)'),
      filter: z.enum(['all', 'manual', 'runcommands', 'relaylog', 'agentlog', 'changenode']).optional()
        .describe('"manual" = notes/records left by people or this server; "runcommands" = commands run; default all'),
      contains: z.string().optional().describe('Only events whose text contains this (case-insensitive)'),
    },
    handler: async ({ node_id, limit, filter, contains }) => {
      const node = await requireNode(node_id);
      const max = limit ?? 40;
      // Fetch extra when filtering by text so the limit applies to matches.
      const events = await deviceEvents(node._id, {
        limit: contains ? Math.min(max * 10, 2000) : max,
        filter: filter && filter !== 'all' ? filter : null,
      });
      const needle = contains?.toLowerCase();
      const lines = events.map(formatEvent).filter((l) => !needle || l.toLowerCase().includes(needle)).slice(0, max);
      const notes = await client.sendCommand({ action: 'getNotes', id: node._id }, 10_000).then((r) => r?.notes).catch(() => null);
      const body =
        (notes ? `Device notes:\n${notes}\n\n` : '') +
        (lines.length ? `Events (newest first; time UTC | user | type | detail):\n${lines.join('\n')}` : 'No matching events.');
      return deviceResult(body, `History of ${node.name}${filter && filter !== 'all' ? ` (${filter})` : ''}:`);
    },
  });

  define({
    name: 'mesh_activity', tier: 'R', title: 'MCP activity log',
    description:
      "This MCP server's own activity record (local log): every device action with when, what, how it was " +
      'approved (prompt / session grant / auto-readonly / blocked / denied), outcome and duration. Filter by device, ' +
      'tool, or time window.',
    schema: {
      device: z.string().optional().describe('Device name (substring) or node ID'),
      tool: z.string().optional().describe('Tool name, e.g. mesh_run_command'),
      since_hours: z.number().positive().optional().describe('Only the last N hours'),
      limit: z.number().int().positive().max(500).optional().describe('Max entries (default 50)'),
    },
    handler: async ({ device, tool, since_hours, limit }) => {
      const entries = audit.read({
        limit: limit ?? 50, nodeName: device ?? null, tool: tool ?? null,
        sinceMs: since_hours ? Date.now() - since_hours * 3_600_000 : null,
      });
      if (!entries.length) return textResult(`No matching activity${audit.file ? ` in ${audit.file}` : ''}.`);
      const lines = entries.map((e) =>
        `${e.ts.replace('T', ' ').slice(0, 19)} | ${(e.nodes ?? []).map((n) => n.name).join(', ') || '-'} | ${e.summary} | ` +
        `${e.approval} | ${e.outcome ?? (e.ok ? 'ok' : `FAILED: ${String(e.error ?? '').replace(/^ERROR: /, '').slice(0, 160)}`)}` +
        `${e.ms != null ? ` | ${(e.ms / 1000).toFixed(1)}s` : ''}`
      );
      return deviceResult(lines.join('\n'), `MCP activity (oldest first; time UTC | devices | action | approval | outcome):`);
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
    description: 'Raw MeshCentral events, optionally filtered by device or user (for a readable device timeline use mesh_device_history).',
    schema: {
      node_id: z.string().optional().describe('Filter by device node ID or name'),
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
    name: 'mesh_list_processes', tier: 'RF', title: 'List processes',
    description: 'Running processes on a device (via the agent process list).',
    schema: { node_id: z.string().describe('Device node ID or name (must be online)') },
    handler: async ({ node_id }) => {
      const value = await processList(await resolveNodeId(node_id));
      if (value == null) return errorResult('No process list returned (device offline or no access).');
      return deviceResult(value, 'Process list:');
    },
  });
}
