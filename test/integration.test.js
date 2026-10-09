// Live integration tests. These require a reachable MeshCentral server and an
// online agent, so they are skipped unless MESH_IT=1 is set. Configure with the
// usual MESH_SERVER_URL / credentials env vars (or a .env file) plus:
//   MESH_TEST_NODE   node id or name of an ONLINE agent to exercise
//   MESH_TEST_SHELL  shell type for the terminal test (default "shell")
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadDotEnv } from '../src/config.js';

loadDotEnv();

const RUN = process.env.MESH_IT === '1';
const NODE = process.env.MESH_TEST_NODE;
const SHELL = process.env.MESH_TEST_SHELL || 'shell';
const opts = { skip: RUN ? false : 'set MESH_IT=1 and MESH_TEST_NODE to run live integration tests' };

let client;
let Client;
let transport;

before(async () => {
  if (!RUN) return;
  const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-it-'));
  const mod = await import('../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const stdio = await import('../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  Client = mod.Client;
  transport = new stdio.StdioClientTransport({
    command: 'node',
    args: ['src/index.js'],
    env: { ...process.env, MESH_MCP_PROFILE: 'admin', MESH_MCP_CONFIRM_MODE: 'off', MESH_LOCAL_FILE_ROOT: jail },
    stderr: 'ignore',
  });
  client = new Client({ name: 'integration', version: '0' });
  await client.connect(transport);
});

after(async () => {
  if (client) await client.close();
});

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
}

test('server info is cached and instant', opts, async () => {
  const r = await call('mesh_server_info');
  assert.equal(r.isError, false);
  assert.match(r.text, /"name"/);
});

test('list devices and resolve the test node by name', opts, async () => {
  const r = await call('mesh_get_device', { node_id: NODE });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /"_id": "node\//);
});

test('run_command captures output', opts, async () => {
  const r = await call('mesh_run_command', { node_id: NODE, command: 'echo mcp_integration_marker' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /mcp_integration_marker/);
});

test('interactive terminal keeps shell state across inputs', opts, async () => {
  const open = await call('mesh_terminal_open', { node_id: NODE, shell: SHELL });
  assert.equal(open.isError, false, open.text);
  const sid = open.text.match(/session_id=(\S+)/)[1];
  try {
    const win = SHELL.includes('cmd') || SHELL.includes('powershell');
    const setCmd = win ? '$env:MCPVAR="persisted"' : 'MCPVAR=persisted';
    const getCmd = win ? 'Write-Output $env:MCPVAR' : 'echo $MCPVAR';
    await call('mesh_terminal_input', { session_id: sid, input: setCmd });
    const got = await call('mesh_terminal_input', { session_id: sid, input: getCmd });
    assert.match(got.text, /persisted/, got.text);
  } finally {
    await call('mesh_terminal_close', { session_id: sid });
  }
});

test('file write/read/delete round-trip with verification', opts, async () => {
  const dir = SHELL.includes('cmd') || SHELL.includes('powershell') ? 'C:\\Windows\\Temp' : '/tmp';
  const name = `mcp_it_${Date.now()}.txt`;
  const full = (SHELL.includes('cmd') || SHELL.includes('powershell')) ? `${dir}\\${name}` : `${dir}/${name}`;
  const w = await call('mesh_file_write', { node_id: NODE, file_path: full, content: 'integration-body' });
  assert.equal(w.isError, false, w.text);
  const r = await call('mesh_file_read', { node_id: NODE, file_path: full });
  assert.match(r.text, /integration-body/, r.text);
  const d = await call('mesh_file_delete', { node_id: NODE, path: dir, names: [name] });
  assert.equal(d.isError, false, d.text);
});

test('local file jail blocks path traversal on download', opts, async () => {
  const r = await call('mesh_file_download', { node_id: NODE, remote_path: '/etc/hostname', local_path: '../escape.txt' });
  assert.equal(r.isError, true);
  assert.match(r.text, /outside the permitted directory/);
});

// Desktop capture needs an active graphical console; gate it separately.
const deskOpts = { skip: RUN && process.env.MESH_TEST_DESKTOP === '1' ? false : 'set MESH_TEST_DESKTOP=1 (needs a device with an active desktop)' };

test('desktop screenshot returns an image with native dimensions', deskOpts, async () => {
  const r = await client.callTool(
    { name: 'mesh_desktop_screenshot', arguments: { node_id: NODE } },
    undefined,
    { timeout: 60_000 }
  );
  assert.equal(!!r.isError, false, r.content.map((c) => c.text).join(' '));
  const img = r.content.find((c) => c.type === 'image');
  assert.ok(img && img.data.length > 1000, 'expected a JPEG image payload');
  assert.match(r.content.find((c) => c.type === 'text').text, /native \d+x\d+/);
});
