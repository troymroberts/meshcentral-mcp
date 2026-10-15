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
