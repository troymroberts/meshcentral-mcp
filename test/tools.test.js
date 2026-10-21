import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerTools } from '../src/register.js';
import { Policy, ConfirmationGate } from '../src/safety.js';
import { AuditLog } from '../src/audit.js';
import { agentRisk, isAgentProcess, isAgentService } from '../src/agent-guard.js';

// ── fakes ───────────────────────────────────────────────────────────────

const NODES = [
  { _id: 'node//win1', name: 'Prudecon-File', conn: 1, pwr: 1, osdesc: 'Windows Server 2022', agent: { id: 4 } },
  { _id: 'node//win2', name: 'Prudecon-DC', conn: 0, osdesc: 'Windows Server 2019', agent: { id: 4 } },
  { _id: 'node//lin1', name: 'web01', conn: 1, osdesc: 'Ubuntu 24.04', agent: { id: 6 } },
];

// Minimal MeshCentral client: answers list actions and routes runcommands to
// a per-test `run(cmd)` that returns a promise of output (or calls `busy`).
class FakeClient {
  domain = '';
  sent = [];
  raw = [];
  #handlers = new Map();
  run = async () => 'ok';

  async sendCommand(cmd, timeoutMs = 30_000) {
    this.sent.push(cmd);
    switch (cmd.action) {
      case 'nodes': return { action: 'nodes', nodes: { 'mesh//g1': NODES } };
      case 'meshes': return { action: 'meshes', meshes: [{ _id: 'mesh//g1', name: 'Group 1' }] };
      case 'lastconnects': return { action: 'lastconnects', lastconnects: { 'node//win2': Date.now() - 3 * 86_400_000 } };
      case 'lastconnect': return { action: 'lastconnect', nodeid: cmd.nodeid, time: Date.now() - 60_000, addr: '10.0.0.5:1234' };
      case 'getNotes': return { action: 'getNotes', notes: null };
      case 'runcommands': {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`MeshCentral did not answer 'runcommands' within ${timeoutMs / 1000}s`)), timeoutMs);
          timer.unref();
        });
        try {
          const out = await Promise.race([this.run(cmd), timeout]);
          return { action: 'msg', type: 'runcommands', result: out };
        } finally { clearTimeout(timer); }
      }
      default: return { action: cmd.action, result: 'ok' };
    }
  }

  async sendRaw(cmd) { this.raw.push(cmd); }

  on(action, handler) {
    if (!this.#handlers.has(action)) this.#handlers.set(action, new Set());
    this.#handlers.get(action).add(handler);
    return () => this.#handlers.get(action)?.delete(handler);
  }

  emit(msg) { for (const h of this.#handlers.get(msg.action) ?? []) h(msg); }

  async collectMessages() { return []; }
  async waitForMessage() { throw new Error('timeout'); }
}

class FakeServer {
  tools = {};
  registerTool(name, meta, cb) { this.tools[name] = { meta, cb }; }
  getClientCapabilities() { return {}; }
}

const CONFIG = {
  terminalIdleMinutes: 15, terminalMaxSessions: 5, desktopIdleMinutes: 10, desktopMaxSessions: 3, desktopIdleFrameMs: 0,
  commandTimeoutSeconds: 300, commandMaxTimeoutSeconds: 3600,
};

function setup({ confirmMode = 'off', deviceEvents = 'changes', profile = 'operations' } = {}) {
  const client = new FakeClient();
  const server = new FakeServer();
  const audit = new AuditLog({ client, deviceEvents });
  const { terminals, desktops } = registerTools({
    server, client, config: CONFIG, audit,
    policy: new Policy({ profile }),
    gate: new ConfirmationGate({ mode: confirmMode }),
  });
  const call = async (name, args = {}) => {
    const r = await server.tools[name].cb(args, {});
    return { text: r.content[0].text, isError: Boolean(r.isError) };
  };
  // The server's wait timers are unref'd (stdio keeps the real process alive);
  // keep the test's event loop alive while fakes never answer.
  const keepAlive = setInterval(() => {}, 1000);
  return { client, server, audit, call, cleanup: () => { clearInterval(keepAlive); terminals.closeAll(); desktops.closeAll(); } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runs = (client) => client.sent.filter((c) => c.action === 'runcommands');

// ── agent guard ─────────────────────────────────────────────────────────

test('agentRisk flags disruptive actions on the Mesh Agent only', () => {
  for (const c of [
    "Restart-Service 'Mesh Agent'", 'Stop-Process -Name MeshAgent -Force', 'sc stop "Mesh Agent"',
    'sc config meshagent start= disabled', 'net stop meshagent', 'systemctl restart meshagent',
    'service meshagent stop', 'taskkill /f /im meshagent.exe', 'Remove-Item "C:\\Program Files\\Mesh Agent\\MeshAgent.msh"',
    'launchctl unload /Library/LaunchDaemons/meshagent.plist',
  ]) assert.ok(agentRisk(c), c);
  for (const c of ['Get-Service "Mesh Agent"', 'systemctl status meshagent', 'Restart-Service Spooler', 'Stop-Process -Id 42', ''])
    assert.equal(agentRisk(c), null, c);
  assert.equal(isAgentProcess('MeshAgent.exe'), true);
  assert.equal(isAgentProcess('notepad.exe'), false);
  assert.equal(isAgentService('Mesh Agent'), true);
  assert.equal(isAgentService('Spooler'), false);
});

test('a command that would stop the agent is blocked before anything is sent', async () => {
  const { client, call, cleanup } = setup();
  const r = await call('mesh_run_command', { node_id: 'Prudecon-File', type: 2, command: "Restart-Service 'Mesh Agent'" });
  assert.equal(r.isError, true);
  assert.match(r.text, /BLOCKED/);
  assert.equal(runs(client).length, 0);
  cleanup();
});

test('allow_agent_disruption still requires a fresh human prompt (session grants ignored)', async () => {
  const { call, cleanup } = setup({ confirmMode: 'token' });
  const r = await call('mesh_run_command', {
    node_id: 'Prudecon-File', type: 2, command: "Restart-Service 'Mesh Agent'", allow_agent_disruption: true,
  });
  assert.match(r.text, /CONFIRMATION REQUIRED[\s\S]*MAY CUT OFF REMOTE ACCESS/);
  cleanup();
});

test('mesh_service_action refuses the agent service and power-off is guarded', async () => {
  const { client, call, cleanup } = setup();
  assert.match((await call('mesh_service_action', { node_id: 'web01', service: 'meshagent', action: 'restart' })).text, /BLOCKED/);
  assert.match((await call('mesh_power_action', { node_ids: ['web01'], action: 'poweroff' })).text, /BLOCKED/);
  assert.equal(runs(client).length, 0);
  cleanup();
});

// ── device lookup ───────────────────────────────────────────────────────

test('device lookup: case-insensitive, partial, ambiguous, unknown', async () => {
  const { call, cleanup } = setup();
  assert.match((await call('mesh_get_device', { node_id: 'prudecon file' })).text, /"name": "Prudecon-File"/);
  assert.match((await call('mesh_get_device', { node_id: 'WEB01' })).text, /"name": "web01"/);
  const amb = await call('mesh_get_device', { node_id: 'prudecon' });
  assert.equal(amb.isError, true);
  assert.match(amb.text, /matches 2 devices/);
  const none = await call('mesh_get_device', { node_id: 'nosuch' });
  assert.match(none.text, /No device matching 'nosuch'. Known devices: Prudecon-DC, Prudecon-File, web01/);
  cleanup();
});

test('mesh_list_devices is compact, with group names and last-connected for offline devices', async () => {
  const { call, cleanup } = setup();
  const list = JSON.parse((await call('mesh_list_devices')).text);
  assert.equal(list.count, 3);
  assert.equal(list.online, 2);
  const dc = list.devices.find((d) => d.name === 'Prudecon-DC');
  assert.equal(dc.group, 'Group 1');
  assert.equal(dc.last_connected, '3d ago');
  assert.equal(dc.agent, undefined); // full records only with detail=true
  cleanup();
});

// ── command queueing, jobs, busy agent ──────────────────────────────────

test('commands to one device run one at a time; other devices run in parallel', async () => {
  const { client, call, cleanup } = setup();
  const log = [];
  client.run = async (cmd) => {
    log.push(`start ${cmd.nodeids[0]} ${cmd.cmds}`);
    await sleep(60);
    log.push(`end ${cmd.nodeids[0]} ${cmd.cmds}`);
    return cmd.cmds;
  };
  await Promise.all([
    call('mesh_run_command', { node_id: 'web01', command: 'hostname' }),
    call('mesh_run_command', { node_id: 'web01', command: 'uptime' }),
    call('mesh_run_command', { node_id: 'Prudecon-File', type: 2, command: 'Get-Date' }),
  ]);
  const i = (s) => log.indexOf(s);
  assert.ok(i('end node//lin1 hostname') < i('start node//lin1 uptime'), log.join(' / '));
  assert.ok(i('start node//win1 Get-Date') < i('end node//lin1 hostname'), 'other device not blocked');
  cleanup();
});

test('a command that outlives timeout_seconds continues as a job and its result is fetchable', async () => {
  const { client, call, cleanup } = setup();
  client.run = async () => { await sleep(1300); return 'slow result'; };
  const r = await call('mesh_run_command', { node_id: 'web01', command: 'hostname', timeout_seconds: 1 });
  assert.equal(r.isError, true);
  const jobId = r.text.match(/job_[0-9a-f]{8}/)[0];
  const s = await call('mesh_job_status', { job_id: jobId, wait_seconds: 5 });
  assert.match(s.text, /slow result/);
  cleanup();
});

test('background=true returns job IDs immediately', async () => {
  const { client, call, cleanup } = setup();
  client.run = async () => { await sleep(100); return 'bg done'; };
  const r = await call('mesh_run_command', { node_ids: ['web01', 'Prudecon-File'], command: 'hostname', background: true });
  const ids = r.text.match(/job_[0-9a-f]{8}/g);
  assert.equal(ids.length, 2);
  assert.match((await call('mesh_job_status', { job_id: ids[0], wait_seconds: 2 })).text, /bg done/);
  cleanup();
});

test('an agent that reports "already busy" fails fast instead of hanging', async () => {
  const { client, call, cleanup } = setup();
  client.run = (cmd) => {
    setTimeout(() => client.emit({ action: 'msg', type: 'console', nodeid: cmd.nodeids[0], value: "Run commands can't execute, already busy." }), 20);
    return new Promise(() => {}); // never answers
  };
  const t0 = Date.now();
  const r = await call('mesh_run_command', { node_id: 'web01', command: 'hostname', timeout_seconds: 30 });
  assert.equal(r.isError, true);
  assert.match(r.text, /busy/);
  assert.ok(Date.now() - t0 < 2000);
  cleanup();
});

test('multi-device run groups output per device', async () => {
  const { client, call, cleanup } = setup();
  client.run = async (cmd) => `out-${cmd.nodeids[0]}`;
  const r = await call('mesh_run_command', { node_ids: ['web01', 'Prudecon-File'], command: 'hostname' });
  assert.match(r.text, /=== web01 \(ok[^)]*\) ===\nout-node\/\/lin1/);
  assert.match(r.text, /=== Prudecon-File \(ok[^)]*\) ===\nout-node\/\/win1/);
  cleanup();
});

test('CMD banner, echoed command and trailing exit are stripped', async () => {
  const { client, call, cleanup } = setup();
  client.run = async () =>
    'Microsoft Windows [Version 10.0.20348.2340]\r\n(c) Microsoft Corporation. All rights reserved.\r\n\r\n' +
    'C:\\Program Files\\Mesh Agent>hostname\r\nPRUDECON-FILE\r\n\r\nC:\\Program Files\\Mesh Agent>exit\r\n';
  const r = await call('mesh_run_command', { node_id: 'Prudecon-File', type: 1, command: 'hostname' });
  assert.match(r.text, /DEVICE_OUTPUT[^\n]*\nPRUDECON-FILE\nDEVICE_OUTPUT>>>/);
  cleanup();
});

test('tail_lines trims command output', async () => {
  const { client, call, cleanup } = setup();
  client.run = async () => Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  const r = await call('mesh_run_command', { node_id: 'web01', command: 'hostname', tail_lines: 2 });
  assert.match(r.text, /\[48 lines omitted\] \.\.\.\nline 49\nline 50/);
  cleanup();
});

// ── activity record & MeshCentral device events ─────────────────────────

test('changes are posted to the device event log; read-only commands are not', async () => {
  const { client, audit, call, cleanup } = setup({ deviceEvents: 'changes' });
  client.run = async () => 'done';
  await call('mesh_run_command', { node_id: 'web01', command: 'hostname' }); // read-only
  assert.equal(client.raw.filter((c) => c.action === 'setDeviceEvent').length, 0);
  await call('mesh_run_command', { node_id: 'web01', command: 'touch /tmp/x' }); // change (confirm off)
  const ev = client.raw.filter((c) => c.action === 'setDeviceEvent');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].nodeid, 'node//lin1');
  assert.match(decodeURIComponent(ev[0].msg), /^\[MCP\] Run on web01 \[auto\]: touch \/tmp\/x \[approval: off\] -> OK/);
  const entries = audit.read({ nodeName: 'web01' });
  assert.deepEqual(entries.map((e) => e.approval), ['auto-readonly', 'off']);
  cleanup();
});

test('mesh_log_event writes an [MCP note] to each device', async () => {
  const { client, call, cleanup } = setup();
  await call('mesh_log_event', { node_ids: ['web01', 'Prudecon-File'], message: 'Cleared disk space on C:' });
  const ev = client.raw.filter((c) => c.action === 'setDeviceEvent');
  assert.deepEqual(ev.map((e) => e.nodeid), ['node//lin1', 'node//win1']);
  assert.equal(decodeURIComponent(ev[0].msg), '[MCP note] Cleared disk space on C:');
  cleanup();
});

test('device events can be turned off', async () => {
  const { client, call, cleanup } = setup({ deviceEvents: 'off' });
  client.run = async () => 'done';
  await call('mesh_run_command', { node_id: 'web01', command: 'touch /tmp/x' });
  assert.equal(client.raw.filter((c) => c.action === 'setDeviceEvent').length, 0);
  cleanup();
});

// ── approvals ───────────────────────────────────────────────────────────

test('a device grant covers that device only', async () => {
  const gate = new ConfirmationGate({ mode: 'token' });
  gate.grant({ tier: 'X', nodeId: 'node//lin1' });
  assert.equal(gate.isGranted('mesh_run_command', 'X', ['node//lin1']), true);
  assert.equal(gate.isGranted('mesh_run_command', 'X', ['node//lin1', 'node//win1']), false);
  assert.equal(gate.isGranted('mesh_run_command', 'WF', ['node//lin1']), false);
  const forced = await gate.decide('mesh_run_command', 'x', {}, 'X', { nodeIds: ['node//lin1'], forcePrompt: true });
  assert.equal(forced.via, 'token-issued'); // grant ignored when forced
});

test('approval prompts offer a per-device choice when one device is involved', async () => {
  let schema;
  const gate = new ConfirmationGate({
    mode: 'auto',
    server: {
      getClientCapabilities: () => ({ elicitation: {} }),
      elicitInput: async (p) => { schema = p.requestedSchema; return { action: 'accept', content: { decision: 'device' } }; },
    },
  });
  const d = await gate.decide('mesh_run_command', 'Run on web01: x', {}, 'X', { nodeIds: ['node//lin1'], device: { id: 'node//lin1', label: 'web01' } });
  assert.equal(d.via, 'prompt');
  assert.ok(schema.properties.decision.enum.includes('device'));
  assert.match(schema.properties.decision.enumNames.join('|'), /on web01 for this session/);
  assert.equal(gate.isGranted('mesh_terminal_input', 'X', ['node//lin1']), true);
});

// ── stuck jobs: agent restarts and manual cancel ────────────────────────

test('an agent disconnect fails the running job and releases the queue', async () => {
  const { client, call, cleanup } = setup();
  let n = 0;
  client.run = (cmd) => (++n === 1 ? new Promise(() => {}) : Promise.resolve(`second: ${cmd.cmds}`));
  const first = await call('mesh_run_command', { node_id: 'web01', command: 'hostname', background: true });
  const jobId = first.text.match(/job_[0-9a-f]{8}/)[0];
  const second = call('mesh_run_command', { node_id: 'web01', command: 'uptime', timeout_seconds: 5 });
  await sleep(50);
  client.emit({ action: 'event', event: { action: 'nodeconnect', nodeid: 'node//lin1', conn: 0 } });
  assert.match((await second).text, /second: uptime/);
  const s = await call('mesh_job_status', { job_id: jobId });
  assert.equal(s.isError, true);
  assert.match(s.text, /disconnected while this command was running/);
  cleanup();
});

test('an agent reconnect after the job started fails it; an older connect time does not', async () => {
  const { client, call, cleanup } = setup();
  client.run = () => new Promise(() => {});
  const r = await call('mesh_run_command', { node_id: 'web01', command: 'hostname', background: true });
  const jobId = r.text.match(/job_[0-9a-f]{8}/)[0];
  await sleep(20);
  client.emit({ action: 'event', event: { action: 'nodeconnect', nodeid: 'node//lin1', conn: 1, ct: Date.now() - 60_000 } });
  assert.match((await call('mesh_job_status', { job_id: jobId })).text, /"status": "running"/);
  client.emit({ action: 'event', event: { action: 'nodeconnect', nodeid: 'node//lin1', conn: 1, ct: Date.now() } });
  assert.match((await call('mesh_job_status', { job_id: jobId })).text, /restarted\/reconnected/);
  cleanup();
});

test('mesh_job_cancel releases a stuck job; "still queued" names the blocking job', async () => {
  const { client, call, cleanup } = setup();
  let n = 0;
  client.run = () => (++n === 1 ? new Promise(() => {}) : Promise.resolve('after cancel'));
  const stuck = await call('mesh_run_command', { node_id: 'web01', command: 'hostname', background: true });
  const stuckId = stuck.text.match(/job_[0-9a-f]{8}/)[0];
  const waiting = await call('mesh_run_command', { node_id: 'web01', command: 'uptime', timeout_seconds: 1 });
  assert.match(waiting.text, new RegExp(`queued on web01 behind job ${stuckId}.*mesh_job_cancel`, 's'));
  const queuedId = waiting.text.match(/Tracked as job (job_[0-9a-f]{8})/)[1];
  assert.match((await call('mesh_job_cancel', { job_id: stuckId })).text, /Cancelled job_/);
  assert.match((await call('mesh_job_status', { job_id: queuedId, wait_seconds: 2 })).text, /after cancel/);
  cleanup();
});

test('mesh_job_cancel by device drops queued jobs before they are sent', async () => {
  const { client, call, cleanup } = setup();
  client.run = () => new Promise(() => {});
  await call('mesh_run_command', { node_id: 'web01', command: 'hostname', background: true });
  await call('mesh_run_command', { node_id: 'web01', command: 'uptime', background: true });
  await sleep(20);
  const r = await call('mesh_job_cancel', { node_id: 'web01' });
  assert.match(r.text, /Cancelled job_[0-9a-f]{8} on web01, job_[0-9a-f]{8} on web01/);
  await sleep(20);
  assert.equal(runs(client).length, 1); // the queued "uptime" was never sent
  cleanup();
});

// ── purpose (plain-English intent for the human) ───────────────────────

test('command tools take purpose first; it leads the approval prompt and heads the result', async () => {
  const { server, client, call, cleanup } = setup({ confirmMode: 'token' });
  for (const name of ['mesh_run_command', 'mesh_terminal_input', 'mesh_agent_console'])
    assert.equal(Object.keys(server.tools[name].meta.inputSchema)[0], 'purpose', name);

  const purpose = 'Restart the print spooler so queued jobs print again';
  const args = { purpose, node_id: 'Prudecon-File', type: 2, command: 'Restart-Service Spooler' };
  const prompt = await call('mesh_run_command', args);
  assert.match(prompt.text, new RegExp(`Purpose: ${purpose}\\n.*Restart-Service Spooler`));

  const token = prompt.text.match(/confirm_token: "(\w+)"/)[1];
  const done = await call('mesh_run_command', { ...args, confirm_token: token });
  assert.match(done.text, new RegExp(`^Purpose: ${purpose}\\nApproval: approved by you`));

  client.run = async () => 'web01';
  const auto = await call('mesh_run_command', { purpose: 'Check the machine name', node_id: 'web01', command: 'hostname' });
  assert.match(auto.text, /^Purpose: Check the machine name\nApproval: auto-approved \(read-only\)\n.*hostname/);
  cleanup();
});

// ── tiering, agent file guard, named rights ─────────────────────────────

test('risky file and access tools are confirmable tiers; consent is a separate admin tool', async () => {
  const { server, cleanup } = setup({ profile: 'admin' });
  const tier = (n) => server.tools[n].meta.description.match(/^\[tier (\w+)\]/)[1];
  for (const n of ['mesh_file_rename', 'mesh_file_copy', 'mesh_file_move']) assert.equal(tier(n), 'WF', n);
  for (const n of ['mesh_change_device_group', 'mesh_create_invite_link', 'mesh_set_device_consent']) assert.equal(tier(n), 'A', n);
  assert.equal(tier('mesh_file_mkdir'), 'W');
  assert.ok(!('consent' in server.tools.mesh_edit_device.meta.inputSchema));
  cleanup();
});

test('file write tools refuse Mesh Agent files', async () => {
  const { call, cleanup } = setup();
  const dir = 'C:\\Program Files\\Mesh Agent';
  for (const [name, args] of [
    ['mesh_file_write', { node_id: 'web01', file_path: '/usr/local/mesh_services/meshagent/meshagent.msh', content: 'x' }],
    ['mesh_file_delete', { node_id: 'Prudecon-File', path: dir, names: ['MeshAgent.exe'] }],
    ['mesh_file_move', { node_id: 'Prudecon-File', source_dir: dir, dest_dir: 'C:\\Temp', names: ['MeshAgent.db'] }],
    ['mesh_file_rename', { node_id: 'Prudecon-File', path: 'C:\\Temp', old_name: 'a', new_name: 'meshagent.msh' }],
  ]) assert.match((await call(name, args)).text, /BLOCKED/, name);
  cleanup();
});

test('mesh_add_user_to_group takes named rights and sends the MeshCentral bitmask', async () => {
  const { client, call, cleanup } = setup({ profile: 'admin' });
  await call('mesh_add_user_to_group', { user_id: 'user//bob', mesh_id: 'mesh//g1', rights: ['remote_control', 'no_desktop', 'edit_notes'] });
  await call('mesh_add_user_to_group', { user_id: 'user//bob', mesh_id: 'mesh//g1', full_rights: true });
  const sent = client.sent.filter((c) => c.action === 'addmeshuser').map((c) => c.meshadmin);
  assert.deepEqual(sent, [8 | 65536 | 128, 4294967295]);
  assert.match((await call('mesh_add_user_to_group', { user_id: 'user//bob', mesh_id: 'mesh//g1' })).text, /full_rights/);
  cleanup();
});

// ── review follow-ups ───────────────────────────────────────────────────

test('power actions send MeshCentral codes (reset=3, sleep=4) and AMT actions', async () => {
  const { client, call, cleanup } = setup();
  for (const action of ['reset', 'amt_power_on', 'amt_reset']) await call('mesh_power_action', { node_ids: ['web01'], action });
  assert.deepEqual(client.sent.filter((c) => c.action === 'poweraction').map((c) => c.actiontype), [3, 302, 310]);
  for (const action of ['sleep', 'poweroff', 'amt_power_off'])
    assert.match((await call('mesh_power_action', { node_ids: ['web01'], action })).text, /BLOCKED/, action);
  cleanup();
});

test('sensitive reads ask; re-capturing an approved desktop session does not', async () => {
  const { call, cleanup } = setup({ confirmMode: 'token' });
  assert.match((await call('mesh_get_clipboard', { node_id: 'web01' })).text, /CONFIRMATION REQUIRED[\s\S]*clipboard of web01/);
  assert.match((await call('mesh_desktop_screenshot', { node_id: 'web01' })).text, /CONFIRMATION REQUIRED[\s\S]*screen/);
  assert.doesNotMatch((await call('mesh_desktop_screenshot', { session_id: 'nope' })).text, /CONFIRMATION REQUIRED/);
  assert.match((await call('mesh_open_url', { node_id: 'web01', url: 'https://example.com/' })).text, /CONFIRMATION REQUIRED/);
  cleanup();
});

test('MESH_MCP_CONFIRM_TIERS=W makes W tools ask; unknown tiers are rejected', async () => {
  const client = new FakeClient();
  const server = new FakeServer();
  registerTools({
    server, client, config: CONFIG, audit: new AuditLog({ client }),
    policy: new Policy({ profile: 'support', confirmTiers: ['W'] }), gate: new ConfirmationGate({ mode: 'token' }),
  });
  const r = await server.tools.mesh_wake_devices.cb({ node_ids: ['web01'] }, {});
  assert.match(r.content[0].text, /CONFIRMATION REQUIRED/);
  assert.throws(() => new Policy({ profile: 'support', confirmTiers: ['Q'] }), /Unknown tier/);
});

test('mesh_edit_device sends tags as an array and [] as the clearing empty string', async () => {
  const { client, call, cleanup } = setup();
  await call('mesh_edit_device', { node_id: 'web01', tags: ['dc', 'site-a'] });
  await call('mesh_edit_device', { node_id: 'web01', tags: [] });
  assert.deepEqual(client.sent.filter((c) => c.action === 'changedevice').map((c) => c.tags), [['dc', 'site-a'], '']);
  cleanup();
});

test('bare usernames become MeshCentral user IDs; device rights exclude group-only bits', async () => {
  const { client, call, cleanup } = setup({ profile: 'admin' });
  await call('mesh_remove_user_from_group', { user_id: 'Bob', mesh_id: 'mesh//g1' });
  await call('mesh_add_device_user', { node_id: 'web01', user_id: 'user//alice', full_rights: true });
  assert.equal(client.sent.find((c) => c.action === 'removemeshuser').userid, 'user//bob');
  const dev = client.sent.find((c) => c.action === 'adddeviceuser');
  assert.deepEqual(dev.userids, ['user//alice']);
  assert.equal(dev.rights & 7, 0);
  cleanup();
});

test('mesh_create_share_link sends access, consent and a time window and returns the URL', async () => {
  const { client, call, cleanup } = setup({ profile: 'admin' });
  const send = client.sendCommand.bind(client);
  client.sendCommand = async (cmd, t) => (cmd.action === 'createDeviceShareLink'
    ? (client.sent.push(cmd), { ...cmd, url: 'https://mesh/sharing?c=abc', publicid: 'p1' }) : send(cmd, t));
  const r = await call('mesh_create_share_link', { node_id: 'web01', guest_name: 'Vendor', access: ['desktop'], duration_minutes: 30 });
  assert.match(r.text, /https:\/\/mesh\/sharing\?c=abc/);
  const c = client.sent.find((x) => x.action === 'createDeviceShareLink');
  assert.equal(c.p, 2);
  assert.equal(c.consent, 0x01 | 0x08 | 0x40); // notify + prompt + toolbar
  assert.equal(c.end - c.start, 1800);
  cleanup();
});

test('mesh_file_download refuses to overwrite an existing local file', async () => {
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dl-'));
  const prev = process.env.MESH_LOCAL_FILE_ROOT;
  process.env.MESH_LOCAL_FILE_ROOT = root;
  fs.writeFileSync(path.join(root, 'a.txt'), 'keep');
  const { call, cleanup } = setup();
  try {
    const r = await call('mesh_file_download', { node_id: 'web01', remote_path: '/etc/hosts', local_path: 'a.txt' });
    assert.match(r.text, /already exists/);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'keep');
  } finally {
    cleanup();
    if (prev === undefined) delete process.env.MESH_LOCAL_FILE_ROOT; else process.env.MESH_LOCAL_FILE_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── software (native Software tab action) ───────────────────────────────

function withServerVersion(client, current) {
  const send = client.sendCommand.bind(client);
  client.sendCommand = async (cmd, t) => (cmd.action === 'serverversion'
    ? { action: 'serverversion', tags: { current } } : send(cmd, t));
}

// Answer pushed 'software' requests: replies(cmd) returns the agent's messages in order.
function softwareAgent(client, replies) {
  const waiters = [];
  client.waitForMessage = (match) => new Promise((resolve) => waiters.push({ match, resolve }));
  client.sendRaw = async (cmd) => {
    client.raw.push(cmd);
    for (const value of replies(cmd)) {
      const msg = { action: 'software', nodeid: cmd.nodeid, value: JSON.stringify(value) };
      const w = waiters.find((x) => x.match(msg));
      if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  };
}

test('mesh_list_software uses the native inventory on MeshCentral 1.3.0+, without a responseid', async () => {
  const { client, call, cleanup } = setup();
  withServerVersion(client, '1.3.0');
  softwareAgent(client, () => [[
    { name: 'Zeta Tool', version: '2.0', publisher: 'Zeta', date: '20260101' },
    { name: 'Alpha App', version: '1.1', publisher: 'Alpha Inc', date: '20251231' },
  ]]);
  const r = await call('mesh_list_software', { node_id: 'Prudecon-File' });
  assert.equal(r.isError, false);
  assert.match(r.text, /Installed software on Prudecon-File \(2\)/);
  assert.ok(r.text.indexOf('Alpha App') < r.text.indexOf('Zeta Tool'), 'sorted by name');
  assert.match(r.text, /2025-12-31/);
  const req = client.raw.find((c) => c.action === 'software');
  assert.equal(req.type, 'installedapps');
  assert.equal(req.responseid, undefined);
  assert.equal(runs(client).length, 0, 'no shell command when the native inventory answers');

  const f = await call('mesh_list_software', { node_id: 'Prudecon-File', filter: 'zeta' });
  assert.match(f.text, /\(1 matching "zeta"\)/);
  assert.doesNotMatch(f.text, /Alpha App/);
  cleanup();
});

test('mesh_list_software keeps the shell inventory on servers older than 1.3.0', async () => {
  const { client, call, cleanup } = setup();
  withServerVersion(client, '1.2.5');
  client.run = async () => 'DisplayName DisplayVersion\n7-Zip 24.08';
  const r = await call('mesh_list_software', { node_id: 'Prudecon-File' });
  assert.match(r.text, /7-Zip/);
  assert.match(r.text, /older than 1\.3\.0/);
  assert.equal(client.raw.filter((c) => c.action === 'software').length, 0);
  cleanup();
});

test('mesh_uninstall_software waits for the exit code, not the "started" notice', async () => {
  const { client, call, cleanup } = setup();
  withServerVersion(client, '1.3.0');
  softwareAgent(client, (cmd) => cmd.type === 'installedapps'
    ? [[{ name: '7-Zip 24.08 (x64)', version: '24.08', uninstall: '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S' }]]
    : [{ status: 'Silent uninstall started' }, { success: true, exitCode: 0 }]);
  const r = await call('mesh_uninstall_software', { purpose: 'test', node_id: 'Prudecon-File', name: '7-Zip 24.08 (x64)' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /exit code 0/);
  const un = client.raw.find((c) => c.type === 'uninstallapp');
  assert.equal(Buffer.from(un.value, 'base64').toString(), '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S');

  const miss = await call('mesh_uninstall_software', { purpose: 'test', node_id: 'Prudecon-File', name: '7-Zip' });
  assert.match(miss.text, /No installed program named exactly/);
  cleanup();
});

// ── registry (remote registry relay, protocol 4) ────────────────────────

import { EventEmitter } from 'node:events';
import { parseRegistryPath, RegistryTunnel } from '../src/registry-tunnel.js';

class FakeRelay extends EventEmitter {
  readyState = 1;
  sent = [];
  constructor(answer) { super(); this.answer = answer; }
  send(text) {
    const cmd = JSON.parse(text);
    this.sent.push(cmd);
    const reply = this.answer(cmd);
    if (reply) setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ action: cmd.action, reqid: cmd.reqid, ...reply }))));
  }
  close() { this.readyState = 3; this.emit('close'); }
}

test('parseRegistryPath accepts short, long and PowerShell hive forms', () => {
  assert.deepEqual(parseRegistryPath('HKLM\\SOFTWARE\\Microsoft'), { hive: 'HKEY_LOCAL_MACHINE', path: 'SOFTWARE\\Microsoft' });
  assert.deepEqual(parseRegistryPath('HKCU:\\Software\\X\\'), { hive: 'HKEY_CURRENT_USER', path: 'Software\\X' });
  assert.deepEqual(parseRegistryPath('hkey_users/S-1-5-18'), { hive: 'HKEY_USERS', path: 'S-1-5-18' });
  assert.deepEqual(parseRegistryPath('HKLM'), { hive: 'HKEY_LOCAL_MACHINE', path: '' });
  assert.throws(() => parseRegistryPath('HKXX\\Foo'), /Unknown registry hive/);
  assert.throws(() => parseRegistryPath(''), /required/);
});

test('RegistryTunnel matches replies by reqid, surfaces agent errors and fails pending calls on close', async () => {
  const ws = new FakeRelay((cmd) => cmd.action === 'list'
    ? { subkeys: ['A'], values: [{ name: 'V', type: 'REG_SZ', value: 'x' }] }
    : cmd.action === 'setvalue' ? { error: 'Access is denied.' } : null);
  const t = new RegistryTunnel(ws);
  const listed = await t.list('HKEY_LOCAL_MACHINE', 'SOFTWARE\\X');
  assert.deepEqual(listed.subkeys, ['A']);
  await assert.rejects(t.setValue('HKEY_LOCAL_MACHINE', 'SOFTWARE\\X', 'V', 'REG_SZ', 'y'), /Access is denied/);
  const pending = t.export('HKEY_LOCAL_MACHINE', 'SOFTWARE\\X');
  ws.close();
  await assert.rejects(pending, /Registry tunnel closed/);
});

function registryRelay(client, answer) {
  const relays = [];
  client.openRelay = async (nodeid, protocol) => {
    const ws = new FakeRelay(answer);
    relays.push({ nodeid, protocol, ws });
    return ws;
  };
  return relays;
}

test('mesh_registry_list opens protocol 4, filters and fences device output', async () => {
  const { client, call, cleanup } = setup();
  const relays = registryRelay(client, (cmd) => ({
    subkeys: ['Policies', 'Microsoft', 'Classes'],
    values: [{ name: 'ProductName', type: 'REG_SZ', value: 'Windows Server 2022' }, { name: 'Other', type: 'REG_DWORD', value: '1' }],
  }));
  const r = await call('mesh_registry_list', { node_id: 'Prudecon-File', key: 'HKLM\\SOFTWARE', filter: 'product' });
  assert.equal(r.isError, false, r.text);
  assert.equal(relays[0].protocol, 4);
  assert.deepEqual({ hive: relays[0].ws.sent[0].hive, path: relays[0].ws.sent[0].path }, { hive: 'HKEY_LOCAL_MACHINE', path: 'SOFTWARE' });
  assert.match(r.text, /ProductName \| REG_SZ \| Windows Server 2022/);
  assert.doesNotMatch(r.text, /Other/);
  assert.match(r.text, /DEVICE_OUTPUT/);
  assert.equal(relays[0].ws.readyState, 3, 'tunnel closed after the call');

  const lin = await call('mesh_registry_list', { node_id: 'web01', key: 'HKLM\\SOFTWARE' });
  assert.match(lin.text, /not a Windows device/);
  cleanup();
});

test('registry writes refuse keys at or just under a hive root', async () => {
  const { client, call, cleanup } = setup();
  const relays = registryRelay(client, () => ({ success: true }));
  for (const [tool, args] of [
    ['mesh_registry_delete', { key: 'HKLM\\SOFTWARE' }],
    ['mesh_registry_set_value', { key: 'HKLM\\SYSTEM', name: 'x', type: 'REG_SZ', data: 'y' }],
    ['mesh_registry_rename', { key: 'HKCU\\Software', new_name: 'z' }],
  ]) {
    const r = await call(tool, { purpose: 'test', node_id: 'Prudecon-File', ...args });
    assert.equal(r.isError, true, tool);
    assert.match(r.text, /too close to the hive root/);
  }
  assert.equal(relays.length, 0, 'nothing was sent');

  const ok = await call('mesh_registry_delete', { purpose: 'test', node_id: 'Prudecon-File', key: 'HKLM\\SOFTWARE\\Vendor\\Old' });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(relays[0].ws.sent[0].items, [{ kind: 'key', hive: 'HKEY_LOCAL_MACHINE', path: 'SOFTWARE\\Vendor', name: 'Old' }]);
  cleanup();
});

test('registry writes on Mesh Agent keys are blocked by the agent guard', async () => {
  const { client, call, cleanup } = setup();
  const relays = registryRelay(client, () => ({ success: true }));
  const r = await call('mesh_registry_set_value', {
    purpose: 'test', node_id: 'Prudecon-File', key: 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Mesh Agent', name: 'Start', type: 'REG_DWORD', data: '4',
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /BLOCKED/);
  assert.equal(relays.length, 0);
  cleanup();
});

// ── Inventory plugin tools ──────────────────────────────────────────────

// Plays the Inventory plugin: replies to {action:'plugin', plugin:'inventory'} by requestId.
function inventoryPlugin(client, handlers) {
  const waiters = [];
  client.waitForMessage = (match) => new Promise((resolve, reject) => {
    waiters.push({ match, resolve });
    setTimeout(() => reject(new Error('timeout')), 200).unref();
  });
  client.sendRaw = async (cmd) => {
    client.raw.push(cmd);
    if (cmd.action !== 'plugin' || cmd.plugin !== 'inventory' || !handlers[cmd.pluginaction]) return;
    let reply;
    try { reply = { ok: true, result: handlers[cmd.pluginaction](cmd) }; } catch (e) { reply = { ok: false, error: e.message }; }
    const msg = { action: 'plugin', plugin: 'inventory', method: 'receiveInventoryMessage', requestId: cmd.requestId, ...reply };
    const w = waiters.find((x) => x.match(msg));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  };
}

const JACK = { id: 'inventorynetport/x/1', site: 'ABC/Default', jack: '2-14', room: 'Cashier', patchPanel: 'A', patchPanelPort: '14',
  switchName: '1 - Ground Floor Main', switchMac: '74:ac:b9:3e:6c:ea', switchPort: 20, status: 'active' };
const ASSET = { id: 'inventoryasset/x/a1', name: 'Prudecon-File', nodeid: 'node//win1', assetKind: 'workstation', status: 'active',
  meshName: 'Group 1', identity: { manufacturer: 'Dell', serial: 'ABC123' }, manual: { location: 'Front office' },
  network: { observed: { connection: 'wired', switchName: '1 - Ground Floor Main', switchPort: 20, site: 'ABC/Default',
    mac: 'a8:a1:59:02:f5:78', ip: '192.168.1.112', seenAt: '2026-10-21T19:00:00Z', source: 'unifi-mcp' },
    resolvedJack: JACK, documentedJack: '', documentedJackInfo: null, knownMacs: ['a8:a1:59:02:f5:78'],
    issues: [{ kind: 'network-mismatch', message: 'Documented jack 1-01 but seen on 2-14' }] } };

test('mesh_inventory_asset maps a device name to its asset and shows the jack chain and issues', async () => {
  const { client, call, cleanup } = setup();
  inventoryPlugin(client, { list: () => ({ assets: [ASSET, { ...ASSET, id: 'inventoryasset/x/a2', nodeid: 'node//lin1', name: 'web01' }] }),
    get: (cmd) => ({ kind: 'asset', asset: cmd.assetId === ASSET.id ? ASSET : null }) });
  const r = await call('mesh_inventory_asset', { asset: 'Prudecon-File' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Observed: wired on switch 1 - Ground Floor Main port 20, site ABC\/Default/);
  assert.match(r.text, /Resolved jack: site ABC\/Default jack 2-14 \(Cashier\) → panel A\/14 → switch 1 - Ground Floor Main port 20/);
  assert.match(r.text, /ISSUE network-mismatch/);
  assert.equal(client.raw.find((c) => c.pluginaction === 'get').assetId, ASSET.id);
  cleanup();
});

test('mesh_inventory_observe turns a find_client match into a network-observe payload', async () => {
  const { client, call, cleanup } = setup();
  let observed;
  inventoryPlugin(client, { list: () => ({ assets: [ASSET] }), get: () => ({ asset: ASSET }),
    'network-observe': (cmd) => { observed = cmd; return { kind: 'network-observed', changed: true, moved: true, stale: false, asset: ASSET }; } });
  const r = await call('mesh_inventory_observe', { asset: 'Prudecon-File', mac: 'a8:a1:59:02:f5:78', ip: '192.168.1.112',
    site: 'ABC/Default', connection: 'wired', switch: { name: '1 - Ground Floor Main', mac: '74:ac:b9:3e:6c:ea', port: 20 } });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /recorded: MOVED/);
  assert.equal(observed.assetId, ASSET.id);
  assert.deepEqual(
    { switchName: observed.observation.switchName, switchMac: observed.observation.switchMac, switchPort: observed.observation.switchPort, source: observed.observation.source },
    { switchName: '1 - Ground Floor Main', switchMac: '74:ac:b9:3e:6c:ea', switchPort: 20, source: 'unifi-mcp' });
  cleanup();
});

test('mesh_inventory_netports lists ports; a missing plugin gives a clear error', async () => {
  const { client, call, cleanup } = setup();
  inventoryPlugin(client, { 'netport-list': () => ({ netports: [{ ...JACK, observedAssets: [{ id: ASSET.id, name: 'Prudecon-File' }],
    issues: [{ kind: 'netport-duplicate-switch-port' }] }], sites: ['ABC/Default'] }) });
  const r = await call('mesh_inventory_netports', { site: 'ABC/Default' });
  assert.match(r.text, /jack 2-14 .*seen: Prudecon-File \| ISSUES: netport-duplicate-switch-port/);
  cleanup();

  const s2 = setup();
  const miss = await s2.call('mesh_inventory_netports', {});
  assert.equal(miss.isError, true);
  assert.match(miss.text, /'inventory' plugin did not answer/);
  s2.cleanup();
});
