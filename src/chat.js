import crypto from 'crypto';

// Text chat with the person at a device, through MeshCentral's MeshMessenger.
//
// The relay forwards JSON between this side and the chat page on the device:
// { action: 'chat', msg } carries a message, { action: 'outtext', value } says
// whether the other side is typing. The page also offers WebRTC, video and file
// transfer; those start only when both sides agree, and this side never does,
// so everything stays on the relay WebSocket.
export class ChatSession {
  #ws;
  #idleTimer = null;
  #idleMs;
  #onEnd;
  #waiters = new Set();
  messages = []; // { from: 'user' | 'you', text, at }
  #readUpTo = 0;

  constructor({ id, ws, nodeId, nodeName, idleMs, onEnd }) {
    this.id = id;
    this.nodeId = nodeId;
    this.nodeName = nodeName;
    this.createdAt = Date.now();
    this.connected = false; // the chat page on the device has joined
    this.typing = false;
    this.closedReason = null;
    this.#ws = ws;
    this.#idleMs = idleMs;
    this.#onEnd = onEnd;
    ws.on('message', (data) => this.#onMessage(data));
    ws.on('close', () => this.#end(this.connected ? 'the user closed the chat window' : 'relay closed'));
    ws.on('error', () => {});
    this.#armIdle();
  }

  get isOpen() { return this.#ws.readyState === 1 && !this.closedReason; }

  #armIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close('idle timeout'), this.#idleMs);
    this.#idleTimer.unref?.();
  }

  #notify() { for (const w of this.#waiters) w(); }

  #onMessage(data) {
    const text = data.toString();
    if (text === 'c' || text === 'cr') { this.connected = true; this.#notify(); return; }
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.ctrlChannel === '102938') {
      if (msg.type === 'ping') this.#send({ ctrlChannel: '102938', type: 'pong' });
      return;
    }
    if (msg.action === 'chat' && typeof msg.msg === 'string') {
      this.messages.push({ from: 'user', text: msg.msg, at: Date.now() });
      this.typing = false;
      this.#armIdle();
      this.#notify();
    } else if (msg.action === 'outtext') {
      this.typing = Boolean(msg.value);
    }
  }

  #send(obj) { this.#ws.send(JSON.stringify(obj)); }

  send(text) {
    if (!this.isOpen) throw new Error(`Chat ${this.id} is closed (${this.closedReason || 'unknown'}).`);
    if (!this.connected) throw new Error('The user has not opened the chat window yet. Wait with mesh_chat_read.');
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

  constructor({ client, idleMinutes = 30 }) {
    this.#client = client;
    this.#idleMs = idleMinutes * 60_000;
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
    const ws = await this.#client.openChatRelay(node._id);
    const session = new ChatSession({
      id: `chat_${crypto.randomBytes(5).toString('hex')}`, ws, nodeId: node._id, nodeName: node.name, idleMs: this.#idleMs,
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
