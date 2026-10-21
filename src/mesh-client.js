import WebSocket from 'ws';
import crypto from 'crypto';
import http from 'http';
import https from 'https';

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

// Resolve a MeshCentral endpoint (e.g. 'control.ashx') against the server URL,
// keeping any path prefix (MeshCentral domains are path-based: https://host/domain/).
export function endpointUrl(serverUrl, endpoint, query = '') {
  const base = new URL(serverUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL(endpoint, base);
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = query;
  return url.toString();
}

export class MeshCentralClient {
  #ws = null;
  #config;
  #pending = new Map(); // responseid -> pending
  #pendingByAction = new Map(); // action -> [pending] (for replies that omit responseid)
  #requestId = 0;
  #connected = false;
  #connecting = null;
  #reconnectTimer = null;
  #reconnectDelay = RECONNECT_MIN_MS;
  #pingTimer = null;
  #pongTimer = null;
  #intentionalClose = false;
  #handlers = new Map();
  #serverInfo = null;
  #userInfo = null;

  constructor(config) {
    this.#config = {
      serverUrl: config.serverUrl,
      username: config.username,
      password: config.password,
      rejectUnauthorized: config.rejectUnauthorized !== false,
    };
  }

  get isConnected() { return this.#connected; }
  get serverInfo() { return this.#serverInfo; }
  get userInfo() { return this.#userInfo; }

  // Domain id of the logged-in user ('' for the default domain): user/<domain>/<name>
  get domain() {
    const id = this.#userInfo?._id;
    return typeof id === 'string' ? id.split('/')[1] ?? '' : '';
  }

  // ID of the logged-in user (user/<domain>/<name>), once userinfo has arrived.
  get userId() {
    return this.#userInfo?._id ?? null;
  }

  // ── MeshMessenger chat relay ──────────────────────────────────────────
  // Joins the relay session meshmessenger/<nodeid>/<userid> as the technician
  // side. The device side is the chat page the agent opens in the logged-in
  // user's browser (action 'meshmessenger'); the relay pairs the two and sends
  // 'c' to both once the page has connected. Returns the open WebSocket.
  async openChatRelay(nodeid) {
    if (!this.userId) await this.sendCommand({ action: 'userinfo' }, 15_000).catch(() => {});
    if (!this.userId) throw new Error('Logged-in user ID unknown; cannot open a chat session.');
    const query = `id=${encodeURIComponent(`meshmessenger/${nodeid}/${this.userId}`)}`;
    const ws = new WebSocket(endpointUrl(this.#config.serverUrl, 'meshrelay.ashx', query), this.#wsOptions());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error('Chat relay did not open.')); }, 15_000);
      ws.once('open', () => { clearTimeout(timer); resolve(); });
      ws.once('error', (err) => { clearTimeout(timer); reject(new Error(`Chat relay error: ${err.message}`)); });
    });
    return ws;
  }

  // GET a static file from the web server (e.g. 'styles/messenger.css'),
  // relative to the server URL. Resolves to the body text, or null on a non-200.
  fetchText(file, timeoutMs = 10_000) {
    const base = new URL(this.#config.serverUrl);
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const url = new URL(file, base);
    const mod = url.protocol === 'https:' ? https : http;
    const opts = url.protocol === 'https:' ? { rejectUnauthorized: this.#config.rejectUnauthorized } : {};
    return new Promise((resolve, reject) => {
      const req = mod.get(url, opts, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(new Error('Response too large.')); });
        res.on('end', () => resolve(body));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out.')));
      req.on('error', reject);
    });
  }

  #wsOptions() {
    const usernameB64 = Buffer.from(this.#config.username).toString('base64');
    const passwordB64 = Buffer.from(this.#config.password).toString('base64');
    return {
      headers: { 'x-meshauth': `${usernameB64},${passwordB64}` },
      agent: this.#config.serverUrl.startsWith('https:')
        ? new https.Agent({ rejectUnauthorized: this.#config.rejectUnauthorized })
        : undefined,
    };
  }

  // ── Connection ────────────────────────────────────────────────────────

  async connect() {
    if (this.#connecting) return this.#connecting;
    if (this.#connected && this.#ws?.readyState === WebSocket.OPEN) return;
    this.#connecting = this.#doConnect().finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  #doConnect() {
    return new Promise((resolve, reject) => {
      this.#intentionalClose = false;
      const ws = new WebSocket(endpointUrl(this.#config.serverUrl, 'control.ashx'), this.#wsOptions());
      this.#ws = ws;
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimer);
        if (err) reject(err); else resolve();
      };
      const handshakeTimer = setTimeout(() => {
        settle(new Error('Timed out waiting for MeshCentral to accept the session'));
        try { ws.terminate(); } catch {}
      }, 20_000);

      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch { return; }

        if (msg.action === 'close') {
          // Server rejected the session (bad credentials, 2FA required, banned IP, ...)
          settle(new Error(`MeshCentral closed the session: ${msg.msg || msg.cause || 'unknown reason'}`));
          return;
        }
        if (msg.action === 'serverinfo') this.#serverInfo = msg.serverinfo ?? null;
        if (msg.action === 'userinfo') this.#userInfo = msg.userinfo ?? null;

        if (!settled && (msg.action === 'serverinfo' || msg.action === 'userinfo')) {
          this.#connected = true;
          this.#reconnectDelay = RECONNECT_MIN_MS;
          this.#startHealthCheck();
          settle();
        }
        this.#handleMessage(msg);
      });

      ws.on('pong', () => clearTimeout(this.#pongTimer));

      ws.on('unexpected-response', (_req, res) => {
        settle(new Error(`MeshCentral rejected the connection: HTTP ${res.statusCode}`));
        try { ws.terminate(); } catch {}
      });

      ws.on('error', (err) => settle(new Error(`WebSocket error: ${err.message}`)));

      ws.on('close', () => {
        settle(new Error('Connection closed before the session was established'));
        if (this.#ws !== ws) return; // a newer socket has replaced this one
        this.#connected = false;
        this.#stopHealthCheck();
        this.#failAllPending(new Error('Connection to MeshCentral closed'));
        if (!this.#intentionalClose) this.#scheduleReconnect();
      });
    });
  }

  #scheduleReconnect() {
    clearTimeout(this.#reconnectTimer);
    const delay = this.#reconnectDelay;
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS);
    this.#reconnectTimer = setTimeout(() => { this.connect().catch(() => {}); }, delay);
    this.#reconnectTimer.unref?.();
  }

  // WebSocket-level ping; a missing pong means the socket is dead even if TCP hasn't noticed.
  #startHealthCheck() {
    this.#stopHealthCheck();
    this.#pingTimer = setInterval(() => {
      const ws = this.#ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      clearTimeout(this.#pongTimer);
      this.#pongTimer = setTimeout(() => { try { ws.terminate(); } catch {} }, PONG_TIMEOUT_MS);
      try { ws.ping(); } catch {}
    }, PING_INTERVAL_MS);
    this.#pingTimer.unref?.();
  }

  #stopHealthCheck() {
    clearInterval(this.#pingTimer);
    clearTimeout(this.#pongTimer);
  }

  disconnect() {
    this.#intentionalClose = true;
    clearTimeout(this.#reconnectTimer);
    this.#stopHealthCheck();
    this.#connected = false;
    if (this.#ws) {
      try { this.#ws.close(); } catch {}
      this.#ws = null;
    }
  }

  // ── Messaging ─────────────────────────────────────────────────────────

  #removePending(p) {
    clearTimeout(p.timer);
    this.#pending.delete(p.responseid);
    const arr = this.#pendingByAction.get(p.action);
    if (arr) {
      const idx = arr.indexOf(p);
      if (idx !== -1) arr.splice(idx, 1);
      if (arr.length === 0) this.#pendingByAction.delete(p.action);
    }
  }

  #failAllPending(err) {
    for (const p of [...this.#pending.values()]) {
      this.#removePending(p);
      p.reject(err);
    }
  }

  #handleMessage(msg) {
    // 1) Replies that echo our responseid (includes agent replies such as msg/runcommands)
    if (msg.responseid != null) {
      const p = this.#pending.get(msg.responseid);
      if (p) {
        this.#removePending(p);
        p.resolve(msg);
        return;
      }
    } else if (msg.action && this.#pendingByAction.has(msg.action)) {
      // 2) Some list actions (meshes, users, events, ...) reply without a responseid.
      //    Many echo `tag`, which sendCommand sets to the responseid, so concurrent
      //    requests (e.g. events for two devices) get their own reply; otherwise
      //    resolve the oldest outstanding request for that action.
      const queue = this.#pendingByAction.get(msg.action);
      const p =
        (msg.tag != null && queue.find((x) => x.responseid === msg.tag)) ||
        (msg.nodeid != null && queue.find((x) => x.nodeid === msg.nodeid)) ||
        queue[0];
      this.#removePending(p);
      p.resolve(msg);
      return;
    }

    // 3) Everything else goes to subscribers
    for (const key of [msg.action, '*']) {
      const set = this.#handlers.get(key);
      if (!set) continue;
      for (const handler of [...set]) {
        try { handler(msg); } catch {}
      }
    }
  }

  // Subscribe to unsolicited messages by action ('*' for all). Returns an unsubscribe function.
  on(action, handler) {
    if (!this.#handlers.has(action)) this.#handlers.set(action, new Set());
    this.#handlers.get(action).add(handler);
    return () => this.#handlers.get(action)?.delete(handler);
  }

  async #ensureConnected() {
    if (this.#connected && this.#ws?.readyState === WebSocket.OPEN) return;
    await this.connect();
    if (!this.#connected || this.#ws?.readyState !== WebSocket.OPEN) throw new Error('Not connected to MeshCentral');
  }

  async sendCommand(command, timeoutMs = 30_000) {
    await this.#ensureConnected();
    const responseid = `mcp_${++this.#requestId}`;
    const action = command.action;
    return new Promise((resolve, reject) => {
      const p = { responseid, action, nodeid: command.nodeid, resolve, reject };
      p.timer = setTimeout(() => {
        this.#removePending(p);
        reject(new Error(`MeshCentral did not answer '${action}' within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.#pending.set(responseid, p);
      if (!this.#pendingByAction.has(action)) this.#pendingByAction.set(action, []);
      this.#pendingByAction.get(action).push(p);
      try {
        this.#ws.send(JSON.stringify({ tag: responseid, ...command, responseid }));
      } catch (err) {
        this.#removePending(p);
        reject(err);
      }
    });
  }

  // Fire-and-forget for actions the server never answers.
  async sendRaw(command) {
    await this.#ensureConnected();
    this.#ws.send(JSON.stringify(command));
  }

  // Wait for the first unsolicited message matching `matchFn`.
  waitForMessage(matchFn, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const off = this.on('*', (msg) => {
        let ok = false;
        try { ok = matchFn(msg); } catch {}
        if (!ok) return;
        clearTimeout(timer);
        off();
        resolve(msg);
      });
      const timer = setTimeout(() => { off(); reject(new Error('Timed out waiting for a reply from the device')); }, timeoutMs);
    });
  }

  // Collect matching messages until none arrive for `idleMs`, or `maxMs` elapses.
  // Starts listening before `trigger` runs so early replies are not missed.
  async collectMessages(matchFn, trigger, { idleMs = 1500, firstMs = 10_000, maxMs = 30_000 } = {}) {
    const out = [];
    let idleTimer;
    let done;
    const finished = new Promise((r) => { done = r; });
    const arm = (ms) => { clearTimeout(idleTimer); idleTimer = setTimeout(done, ms); };
    const off = this.on('*', (msg) => {
      let ok = false;
      try { ok = matchFn(msg); } catch {}
      if (ok) { out.push(msg); arm(idleMs); }
    });
    const maxTimer = setTimeout(done, maxMs);
    try {
      arm(firstMs);
      await trigger();
      await finished;
    } finally {
      off();
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
    }
    return out;
  }

  // ── Relay tunnels (meshrelay.ashx) ─────────────────────────────────────
  // Opens a relay to the agent and selects `protocol`:
  //   1 terminal (admin), 5 files, 6 PowerShell (admin), 8 terminal (user), 9 PowerShell (user)
  // `options` are sent as the relay 'options' control message (e.g. terminal cols/rows).
  // The agent occasionally never acts on a tunnel request (no session starts on the
  // device); a fresh request with a new id then connects normally. So each attempt
  // waits attemptMs and the request is re-issued, up to `attempts` times.
  async openRelay(nodeid, protocol, { options = null, timeoutMs = 25_000, attempts = 3, attemptMs = 8_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    for (let i = 0; i < attempts && Date.now() < deadline; i++) {
      const wait = i === attempts - 1 ? deadline - Date.now() : Math.min(attemptMs, deadline - Date.now());
      try {
        return await this.#openRelayOnce(nodeid, protocol, options, wait);
      } catch (err) {
        lastError = err;
        if (!err.retryable) throw err;
      }
    }
    throw lastError ?? new Error('Tunnel setup timed out (is the device online and its agent connected?)');
  }

  async #openRelayOnce(nodeid, protocol, options, timeoutMs) {
    const cookieResp = await this.sendCommand({ action: 'getcookie', nodeid }, 15_000);
    if (!cookieResp.cookie) throw new Error('Server did not return a tunnel auth cookie (unknown device or no access?)');

    // nodeid and cookie are passed raw: the agent escapes '$'/'@' itself, and '*/'
    // tells it to resolve the path against its own server URL.
    const tunnelId = crypto.randomBytes(16).toString('hex');
    const query = `p=${protocol}&nodeid=${nodeid}&id=${tunnelId}&auth=${cookieResp.cookie}`;
    await this.sendRaw({ action: 'msg', type: 'tunnel', nodeid, value: `*/meshrelay.ashx?${query}` });

    const ws = new WebSocket(endpointUrl(this.#config.serverUrl, 'meshrelay.ashx', query), this.#wsOptions());

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('message', onMessage);
        ws.off('error', onError);
        ws.off('close', onClose);
      };
      const timer = setTimeout(() => {
        cleanup();
        // terminate() on a still-connecting socket emits 'error'; without a listener
        // that is an uncaught exception that kills the server process.
        ws.on('error', () => {});
        try { ws.terminate(); } catch {}
        reject(Object.assign(new Error('Tunnel setup timed out (is the device online and its agent connected?)'), { retryable: true }));
      }, timeoutMs);
      const onMessage = (data) => {
        const s = data.toString();
        if (s !== 'c' && s !== 'cr') return;
        cleanup();
        if (options) ws.send(JSON.stringify({ ctrlChannel: '102938', type: 'options', ...options }));
        ws.send(String(protocol));
        resolve();
      };
      const onError = (err) => { cleanup(); ws.on('error', () => {}); reject(new Error(`Tunnel error: ${err.message}`)); };
      const onClose = () => { cleanup(); reject(new Error('Tunnel closed before setup completed (device offline or access denied?)')); };
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
    });

    return ws;
  }
}
