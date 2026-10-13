import { z } from 'zod';
import { textResult, serverResult } from '../safety.js';

// P — disruptive / agent lifecycle
export default function register(ctx) {
  const { define, client, meshId, resolveNodeId, resolveNodeIds } = ctx;

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
}
