import { z } from 'zod';
import { textResult, deviceResult, serverResult, errorResult, isServerError } from '../safety.js';

// R — inventory & monitoring
export default function register(ctx) {
  const { define, client, getNode, resolveNodeId, withStatus } = ctx;

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
    description: 'List devices (nodes) with online/connection status, optionally filtered by device group name or ID.',
    schema: { group_id: z.string().optional().describe('Device group ID or name to filter by') },
    handler: async ({ group_id }) => {
      const cmd = { action: 'nodes' };
      if (group_id) cmd[group_id.includes('/') ? 'meshid' : 'meshname'] = group_id;
      const res = await client.sendCommand(cmd, 30_000);
      if (!isServerError(res) && res?.nodes && typeof res.nodes === 'object') {
        for (const [mesh, nodes] of Object.entries(res.nodes)) {
          if (Array.isArray(nodes)) res.nodes[mesh] = nodes.map(withStatus);
        }
      }
      return serverResult(res);
    },
  });

  define({
    name: 'mesh_get_device', tier: 'R', title: 'Get device',
    description:
      'Get details for one device by node ID or name, including whether its agent is online ("online", "connection", ' +
      '"power"). Use this, not a command, to check if a device or agent is up.',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) => {
      const node = await getNode(node_id);
      if (!node) return errorResult(`No device matching '${node_id}'`);
      return textResult(withStatus(node));
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
}
