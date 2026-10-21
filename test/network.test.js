import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';

import { registerTools } from '../src/register.js';
import { Policy, ConfirmationGate } from '../src/safety.js';
import { AuditLog } from '../src/audit.js';
import { _resetLocalFileRoot } from '../src/local-path.js';
import { parseChallenges, digestAuthorization, parseTarget, hostMatches, loadCredential, isTextBody, formatHeaders } from '../src/http-relay.js';

// ── unit ────────────────────────────────────────────────────────────────

test('digestAuthorization reproduces the RFC 2617 example', () => {
  const [c] = parseChallenges('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  const h = digestAuthorization(c, { username: 'Mufasa', password: 'Circle Of Life' }, 'GET', '/dir/index.html', 1, '0a4f113b');
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
});

test('parseChallenges handles several schemes, quoted commas and arrays', () => {
  const r = parseChallenges('Digest realm="Login to X", qop="auth", nonce="1", opaque="a,b", Basic realm="y"');
  assert.deepEqual(r.map((c) => c.scheme), ['digest', 'basic']);
  assert.equal(r[0].params.opaque, 'a,b');
  assert.equal(parseChallenges(['Basic realm="a"', 'Digest realm=r, nonce=n, algorithm=SHA-256'])[1].params.algorithm, 'SHA-256');
});

test('parseTarget, hostMatches, isTextBody, formatHeaders', () => {
  assert.deepEqual(parseTarget('https://10.0.0.5:8443/a?b=1'), { https: true, host: '10.0.0.5', port: 8443, path: '/a?b=1', origin: 'https://10.0.0.5:8443' });
  assert.equal(parseTarget('http://cam/').port, 80);
  assert.throws(() => parseTarget('ftp://x/'), /Only http/);
  assert.throws(() => parseTarget('http://u:p@x/'), /credentials in the URL/);
  assert.equal(hostMatches('192.168.10.7', '192.168.10.0/24'), true);
  assert.equal(hostMatches('192.168.11.7', '192.168.10.0/24'), false);
  assert.equal(hostMatches('NVR.local', 'nvr.local'), true);
  assert.equal(isTextBody('application/json; charset=utf-8', Buffer.from('{}')), true);
  assert.equal(isTextBody('image/jpeg', Buffer.from('x')), false);
  assert.equal(isTextBody('', Buffer.from([0, 1, 2])), false);
  assert.equal(formatHeaders(['Set-Cookie', 'sid=abc; Path=/', 'X', '1']), 'Set-Cookie: sid=<elided>\nX: 1');
});

test('loadCredential reads named entries and enforces hosts', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cred-')), 'c.json');
  fs.writeFileSync(file, JSON.stringify({ nvr: { username: 'api', password: 'pw', hosts: ['192.168.10.0/24'] } }));
  assert.deepEqual(loadCredential(file, 'nvr', '192.168.10.5'), { username: 'api', password: 'pw' });
  assert.throws(() => loadCredential(file, 'nvr', '10.0.0.1'), /not allowed for 10.0.0.1/);
  assert.throws(() => loadCredential(file, 'other', '192.168.10.5'), /No credential "other".*Known: nvr/);
  assert.throws(() => loadCredential(null, 'nvr', 'x'), /MESH_HTTP_CREDENTIALS/);
});

// ── tools against a real HTTP server through a fake relay ───────────────

// Stands in for the MeshCentral relay: a WebSocket-like object bridged to a real
// TCP connection, binary frames both ways (what openTcpRelay returns).
class TcpBridgeRelay extends EventEmitter {
  readyState = 1;
  constructor(port, host = '127.0.0.1') {
    super();
    this.sock = net.connect(port, host);
    this.sock.on('data', (d) => this.emit('message', d, true));
    this.sock.on('close', () => { this.readyState = 3; this.emit('close'); });
    this.sock.on('error', () => {});
  }
  send(data, opts, cb) { this.sock.write(data, cb); }
  close() { this.sock.destroy(); }
}

const NODES = [{ _id: 'node//bsl1', name: 'BSL-PC', conn: 1, osdesc: 'Windows 11', agent: { id: 4 } }];
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==', 'base64');

function startDevice() {
  const nonce = crypto.randomBytes(8).toString('hex');
  const seen = [];
  const H = (s) => crypto.createHash('md5').update(s).digest('hex');
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, host: req.headers.host });
    if (req.url.startsWith('/digest')) {
      const a = req.headers.authorization ?? '';
      const p = Object.fromEntries(parseChallenges(a)[0]?.params ? Object.entries(parseChallenges(a)[0].params) : []);
      const ok = a.startsWith('Digest ') && p.response === H(`${H(`api:Login:pw`)}:${nonce}:${p.nc}:${p.cnonce}:auth:${H(`${req.method}:${p.uri}`)}`);
      if (!ok) { res.writeHead(401, { 'WWW-Authenticate': `Digest realm="Login", qop="auth", nonce="${nonce}", opaque="o"` }); return res.end('no'); }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('version=V5.000\r\nserialNumber=ABC\r\n');
    }
    if (req.url === '/basic') {
      if (req.headers.authorization !== `Basic ${Buffer.from('api:pw').toString('base64')}`) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=secret' }); return res.end('{"ok":true}');
    }
    if (req.url === '/snap') { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(JPEG); }
    if (req.url === '/bin') { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.from([0, 1, 2, 3])); }
    if (req.url === '/stream') { res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=x' }); res.write('--x\r\nevent 1\r\n'); return; }
    if (req.method === 'POST') { let b = ''; req.on('data', (d) => { b += d; }); return req.on('end', () => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`got ${req.headers['content-type']} ${b}`); }); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hi</html>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

function setup({ confirmMode = 'off', credFile = null } = {}) {
  const relays = [];
  const client = {
    domain: '',
    async sendCommand(cmd) {
      if (cmd.action === 'nodes') return { action: 'nodes', nodes: { 'mesh//g1': NODES } };
      if (cmd.action === 'meshes') return { action: 'meshes', meshes: [{ _id: 'mesh//g1', name: 'BSL' }] };
      return { action: cmd.action, result: 'ok' };
    },
    async sendRaw() {},
    on() { return () => {}; },
    async openTcpRelay(nodeid, host, port) {
      relays.push({ nodeid, host, port });
      if (host === '10.255.255.1') { const r = new TcpBridgeRelay(1); return r; } // nothing listens: closes at once
      return new TcpBridgeRelay(port);
    },
  };
  const server = { tools: {}, registerTool(name, meta, cb) { this.tools[name] = { meta, cb }; }, getClientCapabilities() { return {}; } };
  const config = {
    terminalIdleMinutes: 15, terminalMaxSessions: 5, desktopIdleMinutes: 10, desktopMaxSessions: 3, desktopIdleFrameMs: 0,
    commandTimeoutSeconds: 300, commandMaxTimeoutSeconds: 3600, httpCredentialsFile: credFile, portForwardIdleMinutes: 30, portForwardMax: 2,
  };
  const out = registerTools({
    server, client, config, audit: new AuditLog({ client, deviceEvents: 'off' }),
    policy: new Policy({ profile: 'operations' }), gate: new ConfirmationGate({ mode: confirmMode }),
  });
  const call = (name, args = {}) => server.tools[name].cb({ purpose: 'test', ...args }, {});
  return { call, relays, server, cleanup: () => { out.terminals.closeAll(); out.desktops.closeAll(); out.portForwards.closeAll(); } };
}

const text = (r) => r.content.map((c) => c.text ?? '').join('\n');

function credFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-cred-')), 'c.json');
  fs.writeFileSync(file, JSON.stringify({ nvr: { username: 'api', password: 'pw', hosts: ['127.0.0.1'] } }));
  return file;
}

test('mesh_http_request answers a Digest challenge, then authenticates up front from the cache', async () => {
  const dev = await startDevice();
  const { call, relays, cleanup } = setup({ credFile: credFile() });
  const url = `http://127.0.0.1:${dev.port}/digest/cgi-bin/magicBox.cgi?action=getSystemInfo`;
  const r = await call('mesh_http_request', { node_id: 'BSL-PC', url, credential: 'nvr' });
  assert.equal(r.isError, undefined, text(r));
  assert.match(text(r), /HTTP 200 OK[\s\S]*auth digest/);
  assert.match(text(r), /DEVICE_OUTPUT[\s\S]*serialNumber=ABC/);
  assert.equal(relays.length, 2, 'challenge + answer');
  assert.deepEqual({ nodeid: relays[0].nodeid, host: relays[0].host, port: relays[0].port }, { nodeid: 'node//bsl1', host: '127.0.0.1', port: dev.port });
  assert.doesNotMatch(text(r), /pw/);

  const again = await call('mesh_http_request', { node_id: 'BSL-PC', url, credential: 'nvr' });
  assert.match(text(again), /HTTP 200[\s\S]*auth digest \(cached\)/);
  assert.equal(relays.length, 3, 'one round trip with the cached challenge');
  assert.match(dev.seen.at(-1).auth, /nc=00000002/);
  cleanup(); dev.server.closeAllConnections(); dev.server.close();
});

test('mesh_http_request: Basic auth, cookies elided, 401 hint without credential', async () => {
  const dev = await startDevice();
  const { call, cleanup } = setup({ credFile: credFile() });
  const url = `http://127.0.0.1:${dev.port}/basic`;
  const no = await call('mesh_http_request', { node_id: 'BSL-PC', url });
  assert.match(text(no), /HTTP 401[\s\S]*pass credential/);
  const r = await call('mesh_http_request', { node_id: 'BSL-PC', url, credential: 'nvr' });
  assert.match(text(r), /HTTP 200[\s\S]*auth basic[\s\S]*Set-Cookie: sid=<elided>[\s\S]*"ok":true/);
  assert.doesNotMatch(text(r), /secret/);
  cleanup(); dev.server.closeAllConnections(); dev.server.close();
});

test('mesh_http_request: images inline, binary needs save_to, save_to writes the body', async () => {
  const dev = await startDevice();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-root-'));
  const prev = process.env.MESH_LOCAL_FILE_ROOT;
  process.env.MESH_LOCAL_FILE_ROOT = root; _resetLocalFileRoot();
  const { call, cleanup } = setup();
  try {
    const img = await call('mesh_http_request', { node_id: 'BSL-PC', url: `http://127.0.0.1:${dev.port}/snap` });
    const part = img.content.find((c) => c.type === 'image');
    assert.equal(part.mimeType, 'image/jpeg');
    assert.equal(Buffer.from(part.data, 'base64').equals(JPEG), true);
    const bin = await call('mesh_http_request', { node_id: 'BSL-PC', url: `http://127.0.0.1:${dev.port}/bin` });
    assert.match(text(bin), /4 bytes application\/octet-stream; pass save_to/);
    const saved = await call('mesh_http_request', { node_id: 'BSL-PC', url: `http://127.0.0.1:${dev.port}/bin`, save_to: 'b.bin' });
    assert.match(text(saved), /4 bytes saved to/);
    assert.deepEqual([...fs.readFileSync(path.join(root, 'b.bin'))], [0, 1, 2, 3]);
  } finally {
    if (prev === undefined) delete process.env.MESH_LOCAL_FILE_ROOT; else process.env.MESH_LOCAL_FILE_ROOT = prev;
    _resetLocalFileRoot(); cleanup(); dev.server.closeAllConnections(); dev.server.close();
  }
});

test('mesh_http_request: an open stream comes back partial at the timeout; POST bodies get a content type', async () => {
  const dev = await startDevice();
  const { call, cleanup } = setup();
  const s = await call('mesh_http_request', { node_id: 'BSL-PC', url: `http://127.0.0.1:${dev.port}/stream`, timeout_seconds: 1 });
  assert.match(text(s), /PARTIAL response: timed out after 1s/);
  assert.match(text(s), /event 1/);
  const p = await call('mesh_http_request', { node_id: 'BSL-PC', url: `http://127.0.0.1:${dev.port}/rpc`, method: 'post', body: '{"method":"global.login"}' });
  assert.match(text(p), /got application\/json \{"method":"global.login"\}/);
  assert.equal(dev.seen.at(-1).host, `127.0.0.1:${dev.port}`);
  cleanup(); dev.server.closeAllConnections(); dev.server.close();
});

test('mesh_http_request: unreachable target, refused headers, credential host fence', async () => {
  const { call, cleanup } = setup({ credFile: credFile() });
  const down = await call('mesh_http_request', { node_id: 'BSL-PC', url: 'http://10.255.255.1/' });
  assert.equal(down.isError, true);
  assert.match(text(down), /could not reach 10.255.255.1:80/);
  const hdr = await call('mesh_http_request', { node_id: 'BSL-PC', url: 'http://127.0.0.1/', headers: { Authorization: 'x' } });
  assert.match(text(hdr), /use a named credential/);
  const fence = await call('mesh_http_request', { node_id: 'BSL-PC', url: 'http://192.168.1.9/', credential: 'nvr' });
  assert.match(text(fence), /not allowed for 192.168.1.9/);
  cleanup();
});

test('mesh_http_request asks for changes (POST, or GET URLs like setConfig/reboot), not for plain reads', async () => {
  const { call, cleanup } = setup({ confirmMode: 'token' });
  const ask = async (args) => /CONFIRMATION REQUIRED/.test(text(await call('mesh_http_request', { node_id: 'BSL-PC', ...args })));
  assert.equal(await ask({ url: 'http://10.0.0.9/cgi-bin/magicBox.cgi?action=reboot' }), true);
  assert.equal(await ask({ url: 'http://10.0.0.9/cgi-bin/configManager.cgi?action=setConfig&NTP.Enable=true' }), true);
  assert.equal(await ask({ url: 'http://10.0.0.9/RPC2', method: 'POST' }), true);
  assert.equal(await ask({ url: 'http://10.0.0.9/cgi-bin/configManager.cgi?action=getConfig&name=NTP' }), false);
  cleanup();
});

test('mesh_port_forward relays local connections to the target and closes cleanly', async () => {
  const dev = await startDevice();
  const { call, relays, cleanup } = setup();
  const r = await call('mesh_port_forward', { node_id: 'BSL-PC', host: '127.0.0.1', port: dev.port });
  const local = text(r).match(/127\.0\.0\.1:(\d+) ->/);
  assert.ok(local, text(r));
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: Number(local[1]), path: '/' }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); }).on('error', reject);
  });
  assert.equal(body, '<html>hi</html>');
  assert.equal(relays.length, 1);
  assert.match(text(await call('mesh_port_forward_list')), /fwd1: 127\.0\.0\.1:\d+ -> 127\.0\.0\.1:\d+ via BSL-PC \| 1 connections/);
  await call('mesh_port_forward', { node_id: 'BSL-PC', host: '127.0.0.1', port: dev.port });
  assert.match(text(await call('mesh_port_forward', { node_id: 'BSL-PC', host: '127.0.0.1', port: dev.port })), /Already 2 port forwards/);
  assert.match(text(await call('mesh_port_forward_close', { id: 'all' })), /Closed 2/);
  await assert.rejects(new Promise((resolve, reject) => net.connect(Number(local[1]), '127.0.0.1').on('connect', resolve).on('error', reject)));
  cleanup(); dev.server.closeAllConnections(); dev.server.close();
});
