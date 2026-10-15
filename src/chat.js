import crypto from 'crypto';

// Text chat with the person at a device, through MeshCentral's MeshMessenger.
//
// The relay forwards JSON between this side and the chat page on the device:
// { action: 'chat', msg } carries a message, { action: 'outtext', value } says
// whether the other side is typing. The page also offers WebRTC, video and file
// transfer; those start only when both sides agree, and this side never does,
// so everything stays on the relay WebSocket.
//
// MeshCentral's relay drops a connection whose partner has not arrived within
// 15 seconds, and the chat page on the device can take longer to open. Until the
// user joins, the session therefore re-joins the relay whenever it is dropped,
// for up to joinMs.
export class ChatSession {
  #ws;
  #idleTimer = null;
  #idleMs;
  #onEnd;
  #waiters = new Set();
  messages = []; // { from: 'user' | 'you', text, at }
  #readUpTo = 0;

  #connect;
  #joinDeadline;

  #onEvent;

  constructor({ id, ws, connect = null, nodeId, nodeName, idleMs, joinMs = 5 * 60_000, onEnd, onEvent = null }) {
    this.id = id;
    this.nodeId = nodeId;
    this.nodeName = nodeName;
    this.createdAt = Date.now();
    this.connected = false; // the chat page on the device has joined
    this.typing = false;
    this.closedReason = null;
    this.#idleMs = idleMs;
    this.#onEnd = onEnd;
    this.#onEvent = onEvent;
    this.#connect = connect;
    this.#joinDeadline = Date.now() + joinMs;
    this.#attach(ws);
    this.#armIdle();
  }

  #attach(ws) {
    this.#ws = ws;
    ws.on('message', (data) => { if (this.#ws === ws) this.#onMessage(data); });
    ws.on('close', () => { if (this.#ws === ws) this.#onClose(); });
    ws.on('error', () => {});
  }

  #onClose() {
    if (this.closedReason) return;
    if (this.connected) return this.#end('the user closed the chat window');
    if (!this.#connect || Date.now() > this.#joinDeadline) return this.#end('the user did not join the chat');
    this.#rejoin();
  }

  async #rejoin() {
    while (!this.closedReason && Date.now() <= this.#joinDeadline) {
      try {
        const ws = await this.#connect();
        if (this.closedReason) { try { ws.close(); } catch {} return; }
        this.#attach(ws);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2_000).unref?.());
      }
    }
    this.#end('the user did not join the chat');
  }

  // Open until ended; while re-joining the relay the socket may briefly be down.
  get isOpen() { return !this.closedReason; }

  #armIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close('idle timeout'), this.#idleMs);
    this.#idleTimer.unref?.();
  }

  #notify() { for (const w of this.#waiters) w(); }

  #onMessage(data) {
    const text = data.toString();
    if (text === 'c' || text === 'cr') {
      if (!this.connected) this.#emit('joined');
      this.connected = true;
      this.#notify();
      return;
    }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.ctrlChannel === '102938') {
      if (msg.type === 'ping') this.#send({ ctrlChannel: '102938', type: 'pong' });
      return;
    }
    if (msg.action === 'chat' && typeof msg.msg === 'string') {
      this.messages.push({ from: 'user', text: msg.msg, at: Date.now() });
      this.typing = false;
      this.#emit('message', msg.msg);
      this.#armIdle();
      this.#notify();
    } else if (msg.action === 'outtext') {
      this.typing = Boolean(msg.value);
    }
  }

  // Report to the manager (which pushes it to the MCP client as a channel event).
  #emit(kind, text = null) {
    try { this.#onEvent?.(this, kind, text); } catch {}
  }

  #send(obj) { this.#ws.send(JSON.stringify(obj)); }

  send(text) {
    if (!this.isOpen) throw new Error(`Chat ${this.id} is closed (${this.closedReason || 'unknown'}).`);
    if (!this.connected || this.#ws.readyState !== 1) throw new Error('The user has not opened the chat window yet. Wait with mesh_chat_read.');
    this.#send({ action: 'chat', msg: text });
    this.messages.push({ from: 'you', text, at: Date.now() });
    this.#armIdle();
  }

  // Messages from the user not returned by an earlier read.
  unread() {
    const out = this.messages.slice(this.#readUpTo).filter((m) => m.from === 'user');
    this.#readUpTo = this.messages.length;
    return out;
  }

  // Resolve once `cond()` holds, the chat ends, or `ms` passes.
  wait(cond, ms) {
    if (cond() || !this.isOpen || ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(check); resolve(); };
      const check = () => { if (cond() || !this.isOpen) done(); };
      const timer = setTimeout(done, ms);
      this.#waiters.add(check);
    });
  }

  #end(reason) {
    if (this.closedReason) return;
    this.closedReason = reason;
    clearTimeout(this.#idleTimer);
    this.#emit('ended', reason);
    this.#notify();
    this.#onEnd?.(this);
  }

  close(reason = 'closed by technician') {
    this.#end(reason);
    try { this.#ws.close(); } catch {}
  }
}

export class ChatManager {
  #sessions = new Map();
  #client;
  #idleMs;

  #onEvent;

  // onEvent(session, kind, text): kind is 'joined', 'message' or 'ended'.
  constructor({ client, idleMinutes = 30, onEvent = null }) {
    this.#client = client;
    this.#idleMs = idleMinutes * 60_000;
    this.#onEvent = onEvent;
  }

  get(id) {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`No chat session '${id}'. It may have ended. Use mesh_chat_list.`);
    return s;
  }

  forNode(nodeId) {
    return [...this.#sessions.values()].find((s) => s.nodeId === nodeId && s.isOpen) ?? null;
  }

  list() {
    return [...this.#sessions.values()].map((s) => ({
      chat_id: s.id, device: s.nodeName, connected: s.connected, open: s.isOpen, closed_reason: s.closedReason,
      messages: s.messages.length, age_seconds: Math.round((Date.now() - s.createdAt) / 1000),
    }));
  }

  // Join the relay first, then ask the agent to open the chat page, so the
  // page finds this side waiting.
  async open(node) {
    const connect = () => this.#client.openChatRelay(node._id);
    const ws = await connect();
    const session = new ChatSession({
      id: `chat_${crypto.randomBytes(5).toString('hex')}`, ws, connect, nodeId: node._id, nodeName: node.name, idleMs: this.#idleMs,
      onEvent: this.#onEvent,
      // Keep ended sessions for a while so the last messages can still be read.
      onEnd: (s) => setTimeout(() => { if (this.#sessions.get(s.id) === s) this.#sessions.delete(s.id); }, 10 * 60_000).unref?.(),
    });
    this.#sessions.set(session.id, session);
    // No reply comes back: MeshCentral silently drops it without the chat/notify right.
    try {
      await this.#client.sendRaw({ action: 'meshmessenger', nodeid: node._id });
    } catch (err) {
      session.close('could not ask the device to open the chat');
      throw err;
    }
    return session;
  }

  closeAll() { for (const s of this.#sessions.values()) s.close('server shutting down'); }
}
