import { z } from 'zod';
import { isAgentProcess, isAgentService } from '../agent-guard.js';
import { textResult, serverResult, errorResult, deviceResult } from '../safety.js';

// P — disruptive / agent lifecycle
export default function register(ctx) {
  const { define, client, meshId, requireNode, resolveNodeId, resolveNodeIds, isWindowsNode, runShell, processList } = ctx;

  // ════════════════════════════════════════════════════════════════════════
  // P — disruptive / agent lifecycle
  // ════════════════════════════════════════════════════════════════════════

  const POWER_MAP = { sleep: 3, reset: 4, poweroff: 2, flash: 400, vibrate: 401 };
  define({
    name: 'mesh_power_action', tier: 'P', title: 'Power action',
    description: 'Send a power action to devices: sleep, reset, poweroff, flash, vibrate.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_ids, action }) => `Power action "${action}" on ${JSON.stringify(node_ids)}`,
    // Off or asleep, the device cannot be reached again unless Wake-on-LAN or
    // Intel AMT is available - treat like disrupting the agent.
    agentRisk: async ({ action }) => (['poweroff', 'sleep'].includes(action)
      ? `"${action}" takes the device offline; it can only come back via Wake-on-LAN, Intel AMT or someone on site`
      : null),
    schema: {
      node_ids: z.array(z.string()).describe('Device node IDs or names'),
      action: z.enum(['sleep', 'reset', 'poweroff', 'flash', 'vibrate']).describe('Power action'),
    },
    handler: async ({ node_ids, action }) =>
      serverResult(await client.sendCommand({ action: 'poweraction', nodeids: await resolveNodeIds(node_ids), actiontype: POWER_MAP[action] }, 15_000)),
  });

  const procName = (p) => String(p?.cmd ?? p?.name ?? '').split(/[\\/]/).pop();

  define({
    name: 'mesh_kill_process', tier: 'P', title: 'Kill process',
    description: 'Kill a process on a device by PID (via the agent process manager), then confirm it is gone. Refuses to kill the Mesh Agent itself.',
    annotations: { destructiveHint: true },
    confirmSummary: async ({ node_id, pid }) => {
      const node = await requireNode(node_id).catch(() => null);
      const procs = node ? await processList(node._id).catch(() => null) : null;
      const name = procs?.[pid] ? ` (${procName(procs[pid])})` : '';
      return `Kill PID ${pid}${name} on ${node?.name ?? node_id}`;
    },
    agentRisk: async ({ node_id, pid }) => {
      const procs = await processList(await resolveNodeId(node_id)).catch(() => null);
      return isAgentProcess(procName(procs?.[pid])) ? `PID ${pid} is the Mesh Agent process` : null;
    },
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      pid: z.number().int().positive().describe('Process ID to kill'),
    },
    handler: async ({ node_id, pid }) => {
      const id = await resolveNodeId(node_id);
      const before = await processList(id).catch(() => null);
      if (before && !before[pid]) return errorResult(`No process with PID ${pid} on the device.`);
      const name = before ? procName(before[pid]) : `PID ${pid}`;
      await client.sendRaw({ action: 'msg', type: 'pskill', nodeid: id, value: String(pid) });
      await new Promise((r) => setTimeout(r, 1500));
      const after = await processList(id).catch(() => null);
      if (!after) return textResult(`Kill sent for ${name} (PID ${pid}); could not re-read the process list to confirm.`);
      if (after[pid]) return errorResult(`${name} (PID ${pid}) is still running after the kill request (access denied, or protected process?).`);
      return textResult(`Killed ${name} (PID ${pid}); it is no longer in the process list.`);
    },
  });

  // Service names as accepted by Get-Service / systemctl (no quoting tricks).
  const SERVICE_NAME = /^[\w.@$ -]{1,128}$/;

  define({
    name: 'mesh_service_action', tier: 'P', title: 'Start/stop/restart service',
    description:
      'Start, stop or restart a service on a device (Windows service name or display name; systemd unit on Linux) ' +
      'and report its resulting state. Never acts on the Mesh Agent service - that would cut off remote access.',
    annotations: { destructiveHint: true },
    confirmSummary: async ({ node_id, service, action }) => `${action[0].toUpperCase() + action.slice(1)} service "${service}" on ${node_id}`,
    agentRisk: async ({ service }) => (isAgentService(service) ? `"${service}" is the Mesh Agent service` : null),
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      service: z.string().describe('Service name or display name (Windows), unit name (Linux)'),
      action: z.enum(['start', 'stop', 'restart']).describe('What to do'),
    },
    handler: async ({ node_id, service, action }) => {
      if (!SERVICE_NAME.test(service)) return errorResult('Service name contains unsupported characters.');
      // Even with allow_agent_disruption, never restart the agent this way: the
      // command runs as the agent's child and dies with it, leaving it stopped.
      if (isAgentService(service) && action !== 'start') {
        return errorResult('Refusing to stop or restart the Mesh Agent through itself: the command would be killed with the agent and the device would stay offline.');
      }
      const node = await requireNode(node_id);
      let out;
      if (isWindowsNode(node)) {
        const name = service.replace(/'/g, "''");
        const verb = { start: 'Start-Service', stop: 'Stop-Service', restart: 'Restart-Service' }[action];
        out = await runShell(node, [
          `$s = Get-Service -Name '${name}' -ErrorAction SilentlyContinue`,
          `if (-not $s) { $s = Get-Service -DisplayName '${name}' -ErrorAction SilentlyContinue }`,
          `if (-not $s) { 'ERROR: no such service'; exit }`,
          `if ("$($s.Name) $($s.DisplayName)" -match 'mesh ?agent') { 'REFUSED: Mesh Agent service'; exit }`,
          `try { ${verb} -InputObject $s -ErrorAction Stop } catch { "ERROR: $($_.Exception.Message)" }`,
          `Start-Sleep -Seconds 2; $s.Refresh()`,
          `"{0} ({1}): {2}, startup {3}" -f $s.Name, $s.DisplayName, $s.Status, $s.StartType`,
        ].join('\n'), 2, 120_000);
      } else {
        out = await runShell(node,
          `systemctl ${action} '${service}' 2>&1; sleep 2; systemctl status '${service}' --no-pager -n 5 2>&1 | head -15`, 3, 120_000);
      }
      const failed = /^(ERROR|REFUSED)/m.test(out) || /Failed to|not found/i.test(out);
      const result = deviceResult(out.trim() || '(no output)', `${action} ${service} on ${node.name}:`);
      return failed ? { ...result, isError: true } : result;
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
    agentRisk: async () => 'uninstalling the agent removes all remote access to the device',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) =>
      serverResult(await client.sendCommand({ action: 'uninstallagent', nodeids: [await resolveNodeId(node_id)] }, 15_000)),
  });

  define({
    name: 'mesh_distribute_core', tier: 'P', title: 'Distribute agent core',
    description: 'Push an agent core to devices (default, clear, recovery, tiny).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_ids, type }) => `Push "${type}" core to ${JSON.stringify(node_ids)}`,
    agentRisk: async () => 'pushing a new agent core restarts the agent; if it does not come back the device is unreachable',
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
    agentRisk: async () => 'an agent update restarts the agent; if it does not come back the device is unreachable',
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
