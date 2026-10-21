import crypto from 'crypto';
import fs from 'fs';
import { z } from 'zod';
import { resolveLocalPath } from '../local-path.js';
import { textResult, deviceResult, errorResult, sanitizeText, truncate } from '../safety.js';
import { RelaySocket, parseTarget, loadCredential, httpRequest, DigestCache, isTextBody, formatHeaders } from '../http-relay.js';

// RF — HTTP(S) and TCP to hosts on a device's network, through MeshCentral TCP relays
// (the agent connects to the LAN address; the server checks the remote-control or
// relay right). For web UIs and APIs of things with no agent of their own: NVRs and
// cameras, printers, switches, UPS cards, iDRAC/iLO, NAS units.
export default function register(ctx) {
  const { define, client, config, requireNode, portForwards } = ctx;
  const digestCache = new DigestCache();
  // One request at a time per target: embedded devices (Dahua) share one Digest
  // challenge per client, and parallel requests get 401s that look like a bad password.
  const targetQueues = new Map();
  const serialized = (key, fn) => {
    const prev = targetQueues.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    targetQueues.set(key, run.finally(() => { if (targetQueues.get(key) === run) targetQueues.delete(key); }).catch(() => {}));
    return run;
  };
  // Lockout guard: devices lock an account after a few failed logins (Dahua: ~5, then
  // minutes; across HTTP, RTSP and SDK). Refuse a credential on a target after 2
  // rejections in 10 minutes rather than risk locking it out.
  const AUTH_FAIL_LIMIT = 2;
  const AUTH_FAIL_WINDOW_MS = 10 * 60_000;
  const authFailures = new Map(); // key -> [timestamps]
  const recentFailures = (key) => (authFailures.get(key) ?? []).filter((t) => Date.now() - t < AUTH_FAIL_WINDOW_MS);

  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  // Many embedded web APIs change state on a GET (Dahua configManager.cgi?action=setConfig,
  // magicBox.cgi?action=reboot, ...): such URLs ask like a POST would.
  const CHANGE_WORDS = /(set|reboot|restart|reset|factory|delete|remove|upgrade|update|modify|add|shutdown|format|apply|save|write|enable|disable|clear)/i;
  const looksLikeChange = (url) => {
    try {
      const u = new URL(url);
      const s = `${u.pathname}${u.search}`;
      return CHANGE_WORDS.test(s.replace(/getconfig|getdefault|getcaps/gi, '')) || /ptz\.cgi[^#]*action=(start|stop)/i.test(s);
    } catch { return false; }
  };

  const BINARY_IMAGE_MAX = 4 * 1024 * 1024;

  define({
    name: 'mesh_http_request', tier: 'RF', title: 'HTTP request through a device', explain: true,
    description:
      'Send one HTTP or HTTPS request to a host on a device\'s network (its LAN), relayed through that device\'s Mesh Agent: ' +
      'web UIs and APIs of NVRs/cameras, printers, switches, UPS cards, iDRAC/iLO, routers. Answers Basic and Digest ' +
      'authentication with a named credential from the local MESH_HTTP_CREDENTIALS file (passwords never go through ' +
      'tool arguments or the device). Returns status, headers and body; images come back as images, other binary ' +
      'bodies need save_to. HTTPS certificates are not verified by default (LAN devices are self-signed). Does not ' +
      'follow redirects. Methods other than GET/HEAD/OPTIONS, and URLs that look like a change (set/reboot/delete...), ' +
      'ask for approval. For a browser session use mesh_port_forward instead.',
    sensitive: ({ method, url }) => !SAFE_METHODS.has((method ?? 'GET').toUpperCase()) || looksLikeChange(url),
    confirmSummary: ({ node_id, method, url, credential }) => `${(method ?? 'GET').toUpperCase()} ${url} via ${node_id}${credential ? ` as credential "${credential}"` : ''}`,
    schema: {
      node_id: z.string().describe('Device whose agent makes the connection (online, on the same network as the target)'),
      url: z.string().describe('Target as the agent sees it, e.g. http://192.168.1.108/cgi-bin/magicBox.cgi?action=getSystemInfo'),
      method: z.string().regex(/^[A-Za-z]+$/).optional().describe('HTTP method (default GET)'),
      headers: z.record(z.string(), z.string()).optional().describe('Extra request headers (no Authorization: use credential)'),
      body: z.string().optional().describe('Request body (text, e.g. JSON or form data)'),
      content_type: z.string().optional().describe('Content-Type for body (default application/json if body parses as JSON, else text/plain)'),
      credential: z.string().optional().describe('Name of a credential in the MESH_HTTP_CREDENTIALS file'),
      auth: z.enum(['auto', 'digest', 'basic', 'none']).optional().describe('auto (default) answers a Basic or Digest challenge; basic sends Basic up front'),
      verify_tls: z.boolean().optional().describe('Verify the HTTPS certificate (default false)'),
      save_to: z.string().optional().describe('Save the response body to this local path (relative to the local file root)'),
      max_body_chars: z.number().int().positive().max(200_000).optional().describe('Max text body characters shown (default 20000)'),
      timeout_seconds: z.number().int().positive().max(300).optional().describe('Response time limit (default 30); a stream still open then is returned as partial'),
    },
    handler: async ({ node_id, url, method, headers, body, content_type, credential, auth, verify_tls, save_to, max_body_chars, timeout_seconds }) => {
      const node = await requireNode(node_id);
      const target = parseTarget(url);
      const m = (method ?? 'GET').toUpperCase();
      const extra = { ...(headers ?? {}) };
      for (const k of Object.keys(extra)) {
        if (/^(authorization|proxy-authorization|host|connection)$/i.test(k)) return errorResult(`Header ${k} is set by the tool${/auth/i.test(k) ? '; use a named credential' : ''}.`);
      }
      if (body != null && !Object.keys(extra).some((k) => k.toLowerCase() === 'content-type')) {
        let json = false;
        try { JSON.parse(body); json = true; } catch {}
        extra['Content-Type'] = content_type ?? (json ? 'application/json' : 'text/plain');
      }
      const cred = credential ? loadCredential(config.httpCredentialsFile, credential, target.host) : null;
      const dest = save_to ? resolveLocalPath(save_to, { mustExist: false }) : null;

      const authKey = `${node._id}|${target.host}|${target.port}|${credential ?? ''}`;
      if (credential && recentFailures(authKey).length >= AUTH_FAIL_LIMIT) {
        return errorResult(`Credential "${credential}" was rejected ${AUTH_FAIL_LIMIT} times by ${target.host} in the last 10 minutes; not trying again (account lockout risk). Check the credentials file, then retry later.`);
      }
      const started = Date.now();
      const res = await serialized(`${node._id}|${target.host}|${target.port}`, () => httpRequest(
        async () => new RelaySocket(await client.openTcpRelay(node._id, target.host, target.port)),
        target,
        {
          method: m, headers: extra, body: body ?? null, credential: cred, auth: auth ?? 'auto',
          cache: digestCache, cacheKey: `${node._id}|${target.host}|${target.port}|${credential ?? ''}`,
          timeoutMs: (timeout_seconds ?? 30) * 1000, verifyTls: Boolean(verify_tls),
        },
      ));
      if (credential && res.status === 401) authFailures.set(authKey, [...recentFailures(authKey), Date.now()]);
      if (credential && res.status !== 401) authFailures.delete(authKey);
      const ms = Date.now() - started;

      const type = String(res.headers['content-type'] ?? '');
      const lines = [
        `HTTP ${res.status} ${res.statusText ?? ''}`.trim() + ` — ${m} ${target.origin}${target.path} via ${node.name} (${(ms / 1000).toFixed(1)}s${res.auth ? `, auth ${res.auth}` : ''})`,
      ];
      if (res.partial) lines.push(`PARTIAL response: ${res.partialReason}`);
      if (res.tls) lines.push(`TLS ${res.tls.protocol}: subject ${res.tls.subject ?? '?'}, issuer ${res.tls.issuer ?? '?'}, valid to ${res.tls.validTo ?? '?'}${res.tls.authorized ? ', verified' : `, NOT verified (${res.tls.authorizationError ?? 'unchecked'})`}`);
      if (res.status === 401 && !credential) lines.push('Authentication required: pass credential (a name from the MESH_HTTP_CREDENTIALS file).');
      if (res.status === 401 && credential) lines.push(`Credential "${credential}" was rejected.`);
      const header = lines.join('\n');
      let text = `${formatHeaders(res.rawHeaders)}\n`;

      if (dest) {
        fs.writeFileSync(dest, res.body);
        const sha = crypto.createHash('sha256').update(res.body).digest('hex');
        return deviceResult(`${text}\n[body: ${res.body.length} bytes saved to ${dest}, sha256 ${sha}]`, header);
      }
      if (/^image\/(png|jpeg|gif|webp)/i.test(type) && res.body.length && res.body.length <= BINARY_IMAGE_MAX && !res.partial) {
        const r = deviceResult(`${text}\n[body: ${res.body.length} bytes ${type}, shown as image]`, header);
        r.content.push({ type: 'image', data: res.body.toString('base64'), mimeType: type.split(';')[0].trim().toLowerCase() });
        return r;
      }
      if (res.body.length === 0) return deviceResult(`${text}\n[empty body]`, header);
      if (!isTextBody(type, res.body)) {
        return deviceResult(`${text}\n[body: ${res.body.length} bytes ${type || 'binary'}; pass save_to to keep it]`, header);
      }
      const max = max_body_chars ?? 20_000;
      const bodyText = res.body.toString('utf8');
      text += `\n${bodyText.length > max ? `${bodyText.slice(0, max)}\n... [${bodyText.length - max} more characters; raise max_body_chars or use save_to]` : bodyText}`;
      return deviceResult(text, header);
    },
  });

  define({
    name: 'mesh_port_forward', tier: 'RF', title: 'Forward a local port through a device', explain: true, sensitive: true,
    description:
      'Open a local port (127.0.0.1) that forwards to host:port on a device\'s network through its Mesh Agent, like ' +
      'MeshCentral Router. Use it to drive a device web UI with a browser (Playwright: browse to http(s)://127.0.0.1:<port>, ' +
      'ignore certificate errors) or point any local tool at a LAN service. Each connection is its own relay. Any local ' +
      'process can use the port while it is open; it closes after the idle time or with mesh_port_forward_close. ' +
      'Web UIs that redirect to their own absolute address or check the Host header may not work through it.',
    confirmSummary: ({ node_id, host, port, local_port }) => `Forward 127.0.0.1:${local_port ?? '<auto>'} -> ${host}:${port} via ${node_id}`,
    schema: {
      node_id: z.string().describe('Device whose agent makes the connections'),
      host: z.string().min(1).describe('Target host/IP as the agent sees it, e.g. 192.168.1.108'),
      port: z.number().int().min(1).max(65535).describe('Target TCP port, e.g. 80, 443, 37777'),
      local_port: z.number().int().min(1024).max(65535).optional().describe('Local port to listen on (default: any free port)'),
    },
    handler: async ({ node_id, host, port, local_port }) => {
      const node = await requireNode(node_id);
      const f = await portForwards.open({ nodeId: node._id, nodeName: node.name, host, port, localPort: local_port ?? 0 });
      const scheme = port === 443 || port === 8443 ? 'https' : 'http';
      return textResult(
        `Forward ${f.id}: ${f.local} -> ${f.target} via ${node.name}.\n` +
        `Browse: ${scheme}://${f.local}/ (likely scheme; ignore certificate errors for HTTPS). ` +
        `Closes after ${config.portForwardIdleMinutes ?? 30} idle minutes or with mesh_port_forward_close id=${f.id}.`,
      );
    },
  });

  define({
    name: 'mesh_port_forward_list', tier: 'R', title: 'List port forwards', audit: false,
    description: 'Port forwards opened with mesh_port_forward in this session: local port, target, device, connection counts, last error.',
    handler: async () => {
      const list = portForwards.list();
      if (!list.length) return textResult('No port forwards open.');
      return textResult(list.map((f) =>
        `${f.id}: ${f.local} -> ${f.target} via ${f.node} | ${f.connections} connections (${f.errors} failed${f.lastError ? `, last: ${sanitizeText(truncate(f.lastError, 200))}` : ''}) | idle close in ~${f.idleMinutesLeft} min`).join('\n'));
    },
  });

  define({
    name: 'mesh_port_forward_close', tier: 'R', title: 'Close a port forward', confirm: false,
    description: 'Close a port forward (and its open connections). id from mesh_port_forward / mesh_port_forward_list; "all" closes every one.',
    schema: { id: z.string().describe('Forward id (fwdN) or "all"') },
    handler: async ({ id }) => {
      if (id === 'all') { const n = portForwards.list().length; portForwards.closeAll(); return textResult(`Closed ${n} port forward(s).`); }
      return portForwards.close(id) ? textResult(`Closed ${id}.`) : errorResult(`No port forward ${id}.`);
    },
  });
}
