import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import fs from 'fs';
import path from 'path';

import { parseEnvFile, resolveCredentials, loadConfig } from '../src/config.js';
import {
  sanitizeText, sanitizeDeep, truncate, isServerError, serverResult, errorResult,
  Policy, PROFILES, ConfirmationGate, argsDigest,
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
  assert.match(truncate('abcdef', 3), /^abc\n\.\.\. \[truncated: 3 more/);
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

test('Policy confirm tiers follow the profile', () => {
  assert.equal(new Policy({ profile: 'support' }).needsConfirm('X'), true);
  assert.equal(new Policy({ profile: 'support' }).needsConfirm('P'), false);
  assert.equal(new Policy({ profile: 'admin', confirmTiers: [] }).needsConfirm('P'), false);
});

test('every profile tier set is a subset of defined tiers', () => {
  for (const p of Object.values(PROFILES)) {
    for (const c of p.confirm) assert.ok(p.tiers.includes(c), `${c} confirmed but not in tiers`);
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
  assert.match(gate.redeemToken('mesh_file_delete', { path: '/x', confirm_token: t3 }, 1000 + 200_000).reason, /expired/);
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
