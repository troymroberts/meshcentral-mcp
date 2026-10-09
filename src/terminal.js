import crypto from 'crypto';
import xterm from '@xterm/headless';
import { sanitizeText } from './safety.js';

const { Terminal } = xterm;

// Protocol numbers understood by the MeshAgent relay.
export const SHELLS = {
  cmd: { protocol: 1, os: 'win32', label: 'Windows CMD / admin terminal' },
  powershell: { protocol: 6, os: 'win32', label: 'Windows PowerShell (admin)' },
  'powershell-user': { protocol: 9, os: 'win32', label: 'Windows PowerShell (logged-in user)' },
  'terminal-user': { protocol: 8, os: 'any', label: 'Terminal as the logged-in user' },
  shell: { protocol: 1, os: 'posix', label: 'Linux/macOS/BSD shell' },
};

const CTRL = '102938'; // MeshCentral terminal control channel id

// A live terminal session: a relay WebSocket plus a headless xterm that renders
// agent output into readable screen text.
export class TerminalSession {
  #ws;
  #term;
  #rawChunks = [];
  #rawBytes = 0;
  #listeners = new Set();
  #idleTimer = null;
  #idleMs;
  #onExpire;

  constructor({ id, ws, shell, nodeId, cols, rows, idleMs, onExpire }) {
    this.id = id;
    this.shell = shell;
    this.nodeId = nodeId;
    this.cols = cols;
    this.rows = rows;
    this.createdAt = Date.now();
    this.#ws = ws;
    this.#idleMs = idleMs;
    this.#onExpire = onExpire;
    this.#term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });

    ws.on('message', (data) => this.#onMessage(data));
    ws.on('close', () => this.#handleClosed('closed'));
    ws.on('error', () => {});
    this.#armIdle();
  }

  get isOpen() { return this.#ws.readyState === 1; }

  #armIdle() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close('idle timeout'), this.#idleMs);
    this.#idleTimer.unref?.();
  }

  #onMessage(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    // Control-channel JSON (ping/pong, resize acks, consent prompts) is not terminal output.
    if (buf.length > 0 && buf[0] === 123) {
      try {
        const msg = JSON.parse(buf.toString('utf8'));
        if (msg.ctrlChannel === CTRL) {
          if (msg.type === 'ping') { try { this.#ws.send(JSON.stringify({ ctrlChannel: CTRL, type: 'pong' })); } catch {} }
          return;
        }
      } catch { /* not JSON control data - fall through as output */ }
    }
    this.#rawChunks.push(buf);
    this.#rawBytes += buf.length;
    this.#term.write(buf);
    this.#armIdle();
    for (const fn of [...this.#listeners]) { try { fn(buf); } catch {} }
  }

  #handleClosed(reason) {
    clearTimeout(this.#idleTimer);
    this.closedReason = this.closedReason || reason;
    this.#onExpire?.(this);
  }

  onData(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  send(text) {
    if (!this.isOpen) throw new Error('Terminal session is closed');
    this.#ws.send(Buffer.from(text, 'utf8'));
    this.#armIdle();
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.#term.resize(cols, rows);
    try { this.#ws.send(JSON.stringify({ ctrlChannel: CTRL, type: 'termsize', cols, rows })); } catch {}
  }

  // Current visible screen (what a user would see right now).
  screen() {
    const buf = this.#term.buffer.active;
    const lines = [];
    for (let i = 0; i < this.#term.rows; i++) {
      const line = buf.getLine(buf.viewportY + i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return sanitizeText(lines.join('\n').replace(/\s+$/, ''));
  }

  // Full scrollback + screen as plain text.
  transcript() {
    const buf = this.#term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return sanitizeText(lines.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim());
  }

  rawBytes() { return this.#rawBytes; }

  close(reason = 'closed by user') {
    this.closedReason = reason;
    clearTimeout(this.#idleTimer);
    try { this.#ws.send(JSON.stringify({ ctrlChannel: CTRL, type: 'close' })); } catch {}
    try { this.#ws.close(); } catch {}
  }
}

// Owns all open terminal sessions for the server process.
export class TerminalManager {
  #sessions = new Map();
  #client;
  #idleMs;
  #max;

  constructor({ client, idleMinutes = 15, maxSessions = 5 }) {
    this.#client = client;
    this.#idleMs = idleMinutes * 60_000;
    this.#max = maxSessions;
  }

  get(id) {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`No terminal session '${id}'. It may have been closed or timed out. Use mesh_terminal_list.`);
    return s;
  }

  list() {
    return [...this.#sessions.values()].map((s) => ({
      session_id: s.id, node_id: s.nodeId, shell: s.shell, cols: s.cols, rows: s.rows,
      open: s.isOpen, age_seconds: Math.round((Date.now() - s.createdAt) / 1000), bytes_received: s.rawBytes(),
    }));
  }

  async open({ nodeId, shell = 'shell', cols = 120, rows = 32 }) {
    const def = SHELLS[shell];
    if (!def) throw new Error(`Unknown shell '${shell}'. Valid: ${Object.keys(SHELLS).join(', ')}`);
    if (this.#sessions.size >= this.#max) {
      throw new Error(`Too many open terminal sessions (max ${this.#max}). Close one with mesh_terminal_close.`);
    }
    const ws = await this.#client.openRelay(nodeId, def.protocol, { options: { cols, rows } });
    const id = `term_${crypto.randomBytes(5).toString('hex')}`;
    const session = new TerminalSession({
      id, ws, shell, nodeId, cols, rows, idleMs: this.#idleMs,
      onExpire: (s) => { if (this.#sessions.get(s.id) === s) this.#sessions.delete(s.id); },
    });
    this.#sessions.set(id, session);
    return session;
  }

  closeAll() {
    for (const s of this.#sessions.values()) s.close('server shutdown');
    this.#sessions.clear();
  }
}

// Wait for terminal output to settle: resolve once no new data has arrived for
// `quietMs`, or `maxMs` elapses. Captures the delta produced since calling.
export function waitForOutput(session, { quietMs = 800, maxMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let timer;
    const done = () => { off(); clearTimeout(timer); clearTimeout(hard); resolve(); };
    const off = session.onData(() => { clearTimeout(timer); timer = setTimeout(done, quietMs); });
    timer = setTimeout(done, quietMs);
    const hard = setTimeout(done, maxMs);
    timer.unref?.(); hard.unref?.();
  });
}
