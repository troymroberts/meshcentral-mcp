import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import net from 'net';
import tls from 'tls';
import { Duplex } from 'stream';

// HTTP(S) to a host on a device's network, carried by a MeshCentral TCP relay
// (client.openTcpRelay). The relay is a WebSocket whose binary frames are the raw
// TCP bytes; RelaySocket turns it into a stream Node's http/tls clients can use.

// ── relay socket ────────────────────────────────────────────────────────

export class RelaySocket extends Duplex {
  #ws;

  constructor(ws) {
    super();
    this.#ws = ws;
    // The server sends a few text control frames ('c', JSON); only binary frames are data.
    ws.on('message', (data, isBinary) => { if (isBinary) this.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); });
    ws.on('close', () => this.push(null));
    ws.on('error', (err) => this.destroy(err));
  }

  _read() {}

  _write(chunk, _enc, cb) {
    if (this.#ws.readyState !== 1) return cb(new Error('Relay closed'));
    this.#ws.send(chunk, { binary: true }, cb);
  }

  _final(cb) { cb(); }

  _destroy(err, cb) {
    try { this.#ws.close(); } catch {}
    cb(err);
  }

  // net.Socket methods the http client may call.
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  setTimeout() { return this; }
  ref() { return this; }
  unref() { return this; }
}

// ── targets ─────────────────────────────────────────────────────────────

// "http://192.168.1.108/cgi-bin/x?y=1" -> { https, host, port, path, origin }
export function parseTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`Not a valid URL: ${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Only http:// and https:// URLs are supported (got ${u.protocol}).`);
  if (u.username || u.password) throw new Error('Do not put credentials in the URL; use a named credential.');
  const https = u.protocol === 'https:';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? Number(u.port) : (https ? 443 : 80);
  return { https, host, port, path: `${u.pathname || '/'}${u.search}`, origin: `${u.protocol}//${u.host}` };
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

// Does `host` match an entry: exact host name/IP (case-insensitive) or an IPv4 CIDR.
export function hostMatches(host, entry) {
  const h = String(host).toLowerCase();
  const e = String(entry).trim().toLowerCase();
  if (!e) return false;
  if (e === '*') return true;
  const cidr = e.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
  if (cidr) {
    if (!net.isIPv4(h)) return false;
    const bits = Number(cidr[2]);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipv4ToInt(h) & mask) === (ipv4ToInt(cidr[1]) & mask);
  }
  return h === e;
}

// ── credentials ─────────────────────────────────────────────────────────

// MESH_HTTP_CREDENTIALS points at a local JSON file of named credentials, so
// passwords never travel through tool arguments, transcripts or the audit log:
//   { "bsl-nvr": { "username": "admin", "password": "...", "hosts": ["192.168.10.0/24"] } }
// `hosts` (optional) limits where a credential may be sent. Read on every use, so
// edits apply without a restart.
export function loadCredential(file, name, host) {
  if (!file) throw new Error('No credentials file: set MESH_HTTP_CREDENTIALS to a local JSON file of named credentials.');
  let all;
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    throw new Error(`Cannot read the credentials file (MESH_HTTP_CREDENTIALS): ${err.code ?? err.message}`);
  }
  const cred = all?.[name];
  if (!cred || typeof cred.username !== 'string' || typeof cred.password !== 'string') {
    throw new Error(`No credential "${name}" with a username and password in the credentials file. Known: ${Object.keys(all ?? {}).join(', ') || '(none)'}`);
  }
  if (Array.isArray(cred.hosts) && cred.hosts.length && !cred.hosts.some((e) => hostMatches(host, e))) {
    throw new Error(`Credential "${name}" is not allowed for ${host} (its hosts: ${cred.hosts.join(', ')}).`);
  }
  return { username: cred.username, password: cred.password };
}

// ── authentication ──────────────────────────────────────────────────────

// Parses one WWW-Authenticate header (possibly several challenges) into
// [{ scheme: 'digest', params: { realm, nonce, ... } }, ...].
export function parseChallenges(header) {
  const src = Array.isArray(header) ? header.join(', ') : String(header ?? '');
  const out = [];
  let current = null;
  let i = 0;
  const skip = () => { while (i < src.length && /[\s,]/.test(src[i])) i++; };
  const token = () => { const m = /^[\w!#$%&'*+.^`|~-]+/.exec(src.slice(i)); if (!m) return null; i += m[0].length; return m[0]; };
  for (skip(); i < src.length; skip()) {
    const name = token();
    if (!name) { i++; continue; }
    let j = i;
    while (src[j] === ' ') j++;
    if (src[j] !== '=' || !current) {
      // A scheme name ("Digest"), or a token68 / stray word before any scheme.
      if (src[j] === '=' && !current) { i = j + 1; token(); continue; }
      current = { scheme: name.toLowerCase(), params: {} };
      out.push(current);
      continue;
    }
    i = j + 1;
    while (src[i] === ' ') i++;
    let value = '';
    if (src[i] === '"') {
      i++;
      while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; value += src[i++] ?? ''; }
      i++;
    } else {
      const m = /^[^,\s]*/.exec(src.slice(i));
      value = m[0];
      i += value.length;
    }
    current.params[name.toLowerCase()] = value;
  }
  return out;
}

const HASHES = { md5: 'md5', 'md5-sess': 'md5', 'sha-256': 'sha256', 'sha-256-sess': 'sha256' };

// Authorization header for a Digest challenge (RFC 7616: MD5/SHA-256, -sess, qop=auth).
export function digestAuthorization(challenge, { username, password }, method, uri, nc = 1, cnonce = crypto.randomBytes(8).toString('hex')) {
  const p = challenge.params;
  const algorithm = (p.algorithm || 'MD5').toLowerCase();
  const hashName = HASHES[algorithm];
  if (!hashName) throw new Error(`Unsupported digest algorithm ${p.algorithm}`);
  const H = (s) => crypto.createHash(hashName).update(s).digest('hex');
  let ha1 = H(`${username}:${p.realm}:${password}`);
  if (algorithm.endsWith('-sess')) ha1 = H(`${ha1}:${p.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const qops = (p.qop || '').split(',').map((q) => q.trim()).filter(Boolean);
  const ncHex = nc.toString(16).padStart(8, '0');
  const parts = [`username="${username}"`, `realm="${p.realm}"`, `nonce="${p.nonce}"`, `uri="${uri}"`];
  if (qops.includes('auth')) {
    parts.push(`qop=auth`, `nc=${ncHex}`, `cnonce="${cnonce}"`, `response="${H(`${ha1}:${p.nonce}:${ncHex}:${cnonce}:auth:${ha2}`)}"`);
  } else if (qops.length) {
    throw new Error(`Unsupported digest qop "${p.qop}" (only "auth")`);
  } else {
    parts.push(`response="${H(`${ha1}:${p.nonce}:${ha2}`)}"`);
  }
  if (p.algorithm) parts.push(`algorithm=${p.algorithm}`);
  if (p.opaque != null) parts.push(`opaque="${p.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export function basicAuthorization({ username, password }) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// ── one HTTP exchange over a relay ──────────────────────────────────────

// Sends one request on `socket` (a RelaySocket) and collects the response.
// Resolves { status, statusText, headers, rawHeaders, body (Buffer), partial, tls }.
// A response still streaming when the time runs out (camera MJPEG, long-poll event
// streams) resolves with what arrived and partial: true.
export function exchange(socket, target, { method, headers, body, timeoutMs, maxBytes, verifyTls }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let res = null;
    const chunks = [];
    let size = 0;
    let tlsInfo = null;

    const finish = (partial, reason = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!res) {
        req.destroy();
        return reject(reason ?? new Error('No response'));
      }
      req.destroy();
      resolve({
        status: res.statusCode, statusText: res.statusMessage, headers: res.headers, rawHeaders: res.rawHeaders,
        body: Buffer.concat(chunks), partial, partialReason: partial ? reason?.message ?? null : null, tls: tlsInfo,
      });
    };

    let conn = socket;
    if (target.https) {
      conn = tls.connect({
        socket,
        servername: net.isIP(target.host) ? undefined : target.host,
        rejectUnauthorized: Boolean(verifyTls),
      });
      conn.once('secureConnect', () => {
        const c = conn.getPeerCertificate();
        tlsInfo = {
          authorized: conn.authorized, authorizationError: conn.authorizationError ? String(conn.authorizationError) : null,
          subject: c?.subject?.CN ?? null, issuer: c?.issuer?.CN ?? null, validTo: c?.valid_to ?? null,
          fingerprint256: c?.fingerprint256 ?? null, protocol: conn.getProtocol(),
        };
      });
    }

    const req = http.request({
      method,
      path: target.path,
      headers: { Host: target.port === (target.https ? 443 : 80) ? target.host : `${target.host}:${target.port}`, Connection: 'close', ...headers },
      createConnection: () => conn,
    }, (response) => {
      res = response;
      response.on('data', (d) => {
        size += d.length;
        if (size > maxBytes) { chunks.push(d.subarray(0, d.length - (size - maxBytes))); return finish(true, new Error(`response larger than ${maxBytes} bytes`)); }
        chunks.push(d);
      });
      response.on('end', () => finish(false));
      response.on('error', (err) => finish(true, err));
      response.on('aborted', () => finish(true, new Error('connection closed mid-response')));
    });

    const timer = setTimeout(() => finish(true, new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    req.on('error', (err) => {
      if (res) return finish(true, err);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const closed = /socket hang up|ECONNRESET|Relay closed|EPIPE|closed before the connection/i.test(err.message);
      reject(closed
        ? new Error(`The agent could not reach ${target.host}:${target.port}, or the connection closed before any response (host down, port closed, wrong scheme, or blocked)${target.https ? '; for HTTPS also check TLS' : ''}.`)
        : err);
    });
    if (body != null) req.write(body);
    req.end();
  });
}

// ── request with authentication ─────────────────────────────────────────

// Digest challenges remembered per target + credential for the session, so later
// calls authenticate up front (one round trip instead of two).
export class DigestCache {
  #map = new Map();
  get(key) { return this.#map.get(key) ?? null; }
  set(key, challenge) { this.#map.set(key, { challenge, nc: 0 }); }
  next(key) { const e = this.#map.get(key); if (!e) return null; e.nc += 1; return e; }
  delete(key) { this.#map.delete(key); }
}

// openSocket() -> Promise<RelaySocket>, one per exchange (each uses Connection: close).
// auth: 'auto' answers a Basic or Digest challenge; 'basic' sends Basic up front;
// 'digest' only answers a Digest challenge; 'none' never sends credentials.
export async function httpRequest(openSocket, target, {
  method = 'GET', headers = {}, body = null, credential = null, auth = 'auto', cache = null, cacheKey = '',
  timeoutMs = 30_000, maxBytes = 25 * 1024 * 1024, verifyTls = false,
}) {
  const send = async (authorization) => {
    const socket = await openSocket();
    return exchange(socket, target, {
      method, body, timeoutMs, maxBytes, verifyTls,
      headers: authorization ? { ...headers, Authorization: authorization } : headers,
    });
  };

  const useCreds = credential && auth !== 'none';
  let first = null;
  let usedAuth = null;
  if (useCreds && auth === 'basic') {
    first = basicAuthorization(credential); usedAuth = 'basic';
  } else if (useCreds && cache && auth !== 'basic') {
    const cached = cache.next(cacheKey);
    if (cached) { first = digestAuthorization(cached.challenge, credential, method, target.path, cached.nc); usedAuth = 'digest (cached)'; }
  }

  let res = await send(first);
  let rounds = 1;
  if (res.status === 401 && useCreds) {
    const challenges = parseChallenges(res.headers['www-authenticate']);
    const digest = challenges.find((c) => c.scheme === 'digest');
    const basic = challenges.find((c) => c.scheme === 'basic');
    let next = null;
    if (digest && auth !== 'basic') {
      cache?.set(cacheKey, digest);
      const e = cache?.next(cacheKey) ?? { nc: 1 };
      next = digestAuthorization(digest, credential, method, target.path, e.nc);
      usedAuth = 'digest';
    } else if (basic && (auth === 'auto') && !first) {
      next = basicAuthorization(credential);
      usedAuth = 'basic';
    }
    if (next) { res = await send(next); rounds = 2; }
    if (res.status === 401) cache?.delete(cacheKey);
  }
  return { ...res, auth: usedAuth, rounds };
}

// ── response formatting ─────────────────────────────────────────────────

const TEXT_TYPE = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|[\w.+-]+\+(json|xml))|image\/svg\+xml)/i;

// Text if the content type says so, or no type and the bytes look like UTF-8 text.
export function isTextBody(contentType, body) {
  // multipart covers both text event streams (Dahua eventManager attach) and MJPEG: judge by the bytes.
  if (contentType && !/^multipart\//i.test(contentType)) return TEXT_TYPE.test(contentType);
  const sample = body.subarray(0, 4096);
  if (sample.includes(0)) return false;
  return !sample.toString('utf8').includes('�');
}

const SECRET_HEADERS = new Set(['set-cookie', 'authorization', 'proxy-authorization', 'cookie']);

// Header lines for display; cookie values are elided (they are session secrets).
export function formatHeaders(rawHeaders) {
  const lines = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = SECRET_HEADERS.has(name.toLowerCase()) ? `${String(rawHeaders[i + 1]).split('=')[0]}=<elided>` : rawHeaders[i + 1];
    lines.push(`${name}: ${value}`);
  }
  return lines.join('\n');
}
