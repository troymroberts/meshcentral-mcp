import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';

import { parseEnvFile, resolveCredentials, loadConfig } from '../src/config.js';
import {
  sanitizeText, sanitizeDeep, truncate, isServerError, serverResult, errorResult,
  Policy, PROFILES, TIERS, ConfirmationGate, argsDigest,
} from '../src/safety.js';
import { splitRemotePath, joinRemotePath, isWindowsPath } from '../src/file-tunnel.js';
import { resolveLocalPath, _resetLocalFileRoot } from '../src/local-path.js';


test('parseEnvFile handles quotes, comments, export', () => {
  const env = parseEnvFile('export A=1\nB="two words" # c\nC=\'x\'\n# comment\nD=\n');
  assert.equal(env.A, '1');
  assert.equal(env.B, 'two words');
  assert.equal(env.C, 'x');
  assert.equal(env.D, '');
});

test('resolveCredentials: token pair, combined, password, errors', () => {
  assert.equal(resolveCredentials({ MESH_TOKEN_USER: '~t:a', MESH_TOKEN_PASS: 'b' }).username, '~t:a');
  assert.match(resolveCredentials({ MESH_TOKEN_USER: '~t:a' }).error, /both be set/);
  assert.equal(resolveCredentials({ MESH_TOKEN: '~t:a,b' }).password, 'b');
  assert.match(resolveCredentials({ MESH_TOKEN: 'justone' }).error, /tokenUser,tokenPass/);
  assert.equal(resolveCredentials({ MESH_USERNAME: 'u', MESH_PASSWORD: 'p' }).kind, 'username/password');
  assert.match(resolveCredentials({}).error, /MESH_USERNAME/);
});

test('loadConfig validates URL and profile defaults', () => {
  assert.match(loadConfig({}).error, /MESH_SERVER_URL/);
  assert.match(loadConfig({ MESH_SERVER_URL: 'not a url' }).error, /not a valid URL/);
  const c = loadConfig({ MESH_SERVER_URL: 'https://h', MESH_USERNAME: 'u', MESH_PASSWORD: 'p' });
  assert.equal(c.profile, 'readonly');
  assert.equal(c.rejectUnauthorized, true);
});

test('sanitizeText strips ANSI CSI, OSC, and control chars', () => {
  assert.equal(sanitizeText('\x1b[31mred\x1b[0m'), 'red');
  assert.equal(sanitizeText('a\x1b]0;title\x07b'), 'ab');
  assert.equal(sanitizeText('x\x00\x07\x1by'), 'xy');
  assert.equal(sanitizeText('keep\ttab\nnl'), 'keep\ttab\nnl');
});

test('sanitizeDeep walks objects and arrays', () => {
  const out = sanitizeDeep({ a: '\x1b[1mX', b: ['\x07y', { c: '\x1b[0mz' }] });
  assert.deepEqual(out, { a: 'X', b: ['y', { c: 'z' }] });
});

test('truncate adds a marker only when over limit', () => {
  assert.equal(truncate('abc', 10), 'abc');
  const t = truncate('a'.repeat(10) + 'MIDDLE' + 'z'.repeat(30), 20);
  assert.match(t, /^aaaaa\n\.\.\. \[truncated: 26 characters omitted\] \.\.\.\nz{15}$/); // 25% head, 75% tail
});

test('isServerError / serverResult map result strings', () => {
  assert.equal(isServerError({ result: 'ok' }), false);
  assert.equal(isServerError({ result: 'OK' }), false);
  assert.equal(isServerError({ result: 'Denied' }), true);
  assert.equal(serverResult({ result: 'Access denied' }).isError, true);
  assert.equal(serverResult({ action: 'meshes', meshes: [] }).isError, undefined);
  assert.equal(errorResult('x').isError, true);
});

test('Policy gates by profile tier and overrides', () => {
  const ro = new Policy({ profile: 'readonly' });
  assert.equal(ro.allows('mesh_list_devices', 'R'), true);
  assert.equal(ro.allows('mesh_run_command', 'X'), false);
  const withOverride = new Policy({ profile: 'readonly', enableTools: ['mesh_run_command'] });
  assert.equal(withOverride.allows('mesh_run_command', 'X'), true);
  const disabled = new Policy({ profile: 'admin', disableTools: ['mesh_server_console'] });
  assert.equal(disabled.allows('mesh_server_console', 'A'), false);
  assert.throws(() => new Policy({ profile: 'nope' }), /Unknown MESH_MCP_PROFILE/);
});

test('Policy confirms X/WF/P/A in every profile, also for tools enabled outside it', () => {
  for (const profile of Object.keys(PROFILES)) {
    const p = new Policy({ profile, enableTools: ['mesh_run_command'] });
    for (const t of ['X', 'WF', 'P', 'A']) assert.equal(p.needsConfirm(t), true, `${profile} ${t}`);
    for (const t of ['R', 'RF', 'W']) assert.equal(p.needsConfirm(t), false, `${profile} ${t}`);
  }
  assert.equal(new Policy({ profile: 'admin', confirmTiers: [] }).needsConfirm('P'), false);
});

test('every profile tier set is a subset of defined tiers', () => {
  for (const p of Object.values(PROFILES)) {
    for (const t of p.tiers) assert.ok(t in TIERS, `${t} is not a defined tier`);
  }
});

test('argsDigest ignores confirm_token and is order-independent', () => {
  assert.equal(argsDigest('t', { a: 1, b: 2 }), argsDigest('t', { b: 2, a: 1 }));
  assert.equal(argsDigest('t', { a: 1 }), argsDigest('t', { a: 1, confirm_token: 'x' }));
  assert.notEqual(argsDigest('t', { a: 1 }), argsDigest('t', { a: 2 }));
});

test('ConfirmationGate token mode: issue, bind to args, single-use, expiry', () => {
  const gate = new ConfirmationGate({ mode: 'token' });
  const token = gate.issueToken('mesh_file_delete', { path: '/x', names: ['a'] });
  assert.equal(gate.redeemToken('mesh_file_delete', { path: '/x', names: ['a'], confirm_token: token }).ok, true);
  // single use
  assert.equal(gate.redeemToken('mesh_file_delete', { path: '/x', names: ['a'], confirm_token: token }).ok, false);
  // bound to args
  const t2 = gate.issueToken('mesh_file_delete', { path: '/x', names: ['a'] });
  assert.match(gate.redeemToken('mesh_file_delete', { path: '/y', names: ['a'], confirm_token: t2 }).reason, /does not match/);
  // expiry
  const t3 = gate.issueToken('mesh_file_delete', { path: '/x' }, 1000);
  assert.match(gate.redeemToken('mesh_file_delete', { path: '/x', confirm_token: t3 }, 1000 + 700_000).reason, /expired/);
});

test('ConfirmationGate.check issues then accepts a matching token', async () => {
  const gate = new ConfirmationGate({ mode: 'token' });
  const first = await gate.check('mesh_power_action', 'poweroff X', { node_ids: ['n'], action: 'poweroff' });
  assert.match(first.content[0].text, /CONFIRMATION REQUIRED/);
  const token = first.content[0].text.match(/confirm_token: "([a-f0-9]+)"/)[1];
  const second = await gate.check('mesh_power_action', 'poweroff X', { node_ids: ['n'], action: 'poweroff', confirm_token: token });
  assert.equal(second, null); // null => allowed to proceed
});

test('remote path helpers respect the remote OS, not this host', () => {
  assert.equal(isWindowsPath('C:\\Users\\x'), true);
  assert.equal(isWindowsPath('/etc/passwd'), false);
  assert.deepEqual(splitRemotePath('C:\\Users\\a\\f.txt'), { dir: 'C:\\Users\\a', name: 'f.txt' });
  assert.deepEqual(splitRemotePath('/var/log/syslog'), { dir: '/var/log', name: 'syslog' });
  assert.equal(joinRemotePath('C:\\a', 'b.txt'), 'C:\\a\\b.txt');
  assert.equal(joinRemotePath('/a', 'b.txt'), '/a/b.txt');
});

test('resolveLocalPath confines to the jail and blocks traversal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpjail-'));
  _resetLocalFileRoot();
  const env = { MESH_LOCAL_FILE_ROOT: root };
  const inside = resolveLocalPath('sub/f.txt', { env });
  assert.ok(inside.startsWith(fs.realpathSync(root)));
  assert.throws(() => resolveLocalPath('../escape.txt', { env }), /outside the permitted directory/);
  assert.throws(() => resolveLocalPath('/etc/passwd', { env }), /outside the permitted directory/);
  _resetLocalFileRoot();
});






test('resolveLocalPath blocks symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpjail-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpout-'));
  fs.symlinkSync(outside, path.join(root, 'link'));
  _resetLocalFileRoot();
  const env = { MESH_LOCAL_FILE_ROOT: root };
  assert.throws(() => resolveLocalPath('link/evil.txt', { env }), /symbolic link/);
  _resetLocalFileRoot();
});

// ── chat ────────────────────────────────────────────────────────────────

test('ChatSession: join, typing, messages, unread tracking, waits and close', async () => {
  const { EventEmitter } = await import('events');
  const { ChatSession } = await import('../src/chat.js');
  const ws = Object.assign(new EventEmitter(), { readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); }, close() { this.readyState = 3; this.emit('close'); } });
  const s = new ChatSession({ id: 'chat_x', ws, nodeId: 'node//a', nodeName: 'PC', idleMs: 60_000 });
  assert.throws(() => s.send('hi'), /not opened the chat window/);
  const joined = s.wait(() => s.connected, 1000);
  ws.emit('message', Buffer.from('c'));
  await joined;
  assert.equal(s.connected, true);
  ws.emit('message', Buffer.from(JSON.stringify({ ctrlChannel: '102938', type: 'ping' })));
  assert.deepEqual(ws.sent.at(-1), { ctrlChannel: '102938', type: 'pong' });
  s.send('hello');
  assert.deepEqual(ws.sent.at(-1), { action: 'chat', msg: 'hello' });
  ws.emit('message', Buffer.from(JSON.stringify({ action: 'outtext', value: true })));
  assert.equal(s.typing, true);
  const reply = s.wait(() => s.messages.length > 1, 1000);
  ws.emit('message', Buffer.from(JSON.stringify({ action: 'chat', msg: 'printer jammed' })));
  await reply;
  assert.equal(s.typing, false);
  assert.deepEqual(s.unread().map((m) => m.text), ['printer jammed']);
  assert.deepEqual(s.unread(), []);
  const t0 = Date.now();
  await s.wait(() => false, 50);
  assert.ok(Date.now() - t0 >= 45);
  ws.close();
  assert.equal(s.isOpen, false);
  assert.match(s.closedReason, /user closed/);
  assert.throws(() => s.send('x'), /closed/);
});

test('ChatSession re-joins the relay while waiting for the user, and gives up after joinMs', async () => {
  const { EventEmitter } = await import('events');
  const { ChatSession } = await import('../src/chat.js');
  const mk = () => Object.assign(new EventEmitter(), { readyState: 1, sent: [], send(d) { this.sent.push(d); }, close() { this.readyState = 3; this.emit('close'); } });
  const sockets = [mk()];
  const s = new ChatSession({ id: 'c', ws: sockets[0], connect: async () => { sockets.push(mk()); return sockets.at(-1); }, nodeId: 'n', nodeName: 'PC', idleMs: 60_000, joinMs: 1_000 });
  sockets[0].emit('close'); // relay dropped the unpaired socket after 15 s
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sockets.length, 2);
  assert.equal(s.isOpen, true);
  sockets[1].emit('message', Buffer.from('c'));
  assert.equal(s.connected, true);
  sockets[1].emit('close');
  assert.match(s.closedReason, /user closed/);

  const late = new ChatSession({ id: 'd', ws: mk(), connect: async () => mk(), nodeId: 'n', nodeName: 'PC', idleMs: 60_000, joinMs: 0 });
  await new Promise((r) => setTimeout(r, 5));
  late.close('x'); // joinMs 0: a drop ends it instead of re-joining
  assert.equal(late.isOpen, false);
});

test('ChatSession reports joined / message / ended events', async () => {
  const { EventEmitter } = await import('events');
  const { ChatSession } = await import('../src/chat.js');
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() { this.readyState = 3; this.emit('close'); } });
  const events = [];
  const s = new ChatSession({ id: 'c', ws, nodeId: 'n', nodeName: 'PC', idleMs: 60_000, onEvent: (_, kind, text) => events.push([kind, text]) });
  ws.emit('message', Buffer.from('c'));
  ws.emit('message', Buffer.from('c')); // repeated pairing notice: one 'joined' only
  ws.emit('message', Buffer.from(JSON.stringify({ action: 'chat', msg: 'hello' })));
  s.close('done');
  assert.deepEqual(events, [['joined', null], ['message', 'hello'], ['ended', 'done']]);
});

test('cssKeepsLineBreaks: detects white-space on the remote bubble', async () => {
  const { cssKeepsLineBreaks } = await import('../src/chat.js');
  assert.equal(cssKeepsLineBreaks(null), false);
  assert.equal(cssKeepsLineBreaks('.remoteBubble { color: black; }'), false);
  assert.equal(cssKeepsLineBreaks('.localBubble { white-space: pre-wrap; }'), false);
  assert.equal(cssKeepsLineBreaks('.remoteBubble { color: black; }\n.remoteBubble,\n.localBubble { white-space: pre-wrap; }'), true);
  assert.equal(cssKeepsLineBreaks('.remoteBubble{white-space:pre-line}'), true);
});

test('formatChatMessage: plain text, one bubble or one per line', async () => {
  const { formatChatMessage } = await import('../src/chat.js');
  const md = 'Checked the **System** log:\n\n- no `errors`\n- one warning\n\n\n\nDone.';
  assert.deepEqual(formatChatMessage(md, true), ['Checked the System log:\n\n• no errors\n• one warning\n\nDone.']);
  assert.deepEqual(formatChatMessage(md, false), ['Checked the System log:', '• no errors', '• one warning', 'Done.']);
  assert.deepEqual(formatChatMessage('hello', false), ['hello']);
  assert.deepEqual(formatChatMessage('a\r\nb', false), ['a', 'b']);
});

test('ChatSession.setDiagnostics: wakes waiters and reports a diagnostics event', async () => {
  const { ChatSession } = await import('../src/chat.js');
  const { EventEmitter } = await import('events');
  const ws = Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() {} });
  const events = [];
  const s = new ChatSession({ id: 'chat_d', ws, nodeId: 'node//a', nodeName: 'PC', idleMs: 60_000, onEvent: (_s, kind) => events.push(kind) });
  s.diagnostics = { status: 'running', startedAt: Date.now() };
  const waited = s.wait(() => s.diagnostics.status !== 'running', 5_000);
  s.setDiagnostics({ status: 'done', text: 'disk C: 14% free' });
  await waited;
  assert.equal(s.diagnostics.status, 'done');
  assert.ok(s.diagnostics.finishedAt >= s.diagnostics.startedAt);
  assert.deepEqual(events, ['diagnostics']);
  s.close();
});
