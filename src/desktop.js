import crypto from 'crypto';
import jpeg from 'jpeg-js';

// MeshCentral remote-desktop (KVM) protocol over a relay opened with protocol 2.
// Wire format: [cmd:uint16][size:uint16][payload...]; size includes the 4-byte header.
//   cmd 3  tile      [X:uint16][Y:uint16][JPEG...]   (JPEG covers a WxH region at X,Y)
//   cmd 7  screensize [W:uint16][H:uint16]
// Control frames are JSON (first byte '{') and are handled out of band.
// The agent emits cmd 7 first; the client replies with compression + unpause.
const CMD_TILE = 3;
const CMD_SCREEN = 7;

const INPUT = { KEY: 1, MOUSE: 2, CTRLALTDEL: 10, KEYUNICODE: 85 };
const MOUSE_BTN = { none: 0x00, left: 0x02, right: 0x08, middle: 0x20 };

function u16(n) { return Buffer.from([(n >> 8) & 0xff, n & 0xff]); }

export class DesktopSession {
  #ws;
  #acc = Buffer.alloc(0);
  #fb = null; // RGBA framebuffer (Buffer) of width*height*4
  #width = 0;
  #height = 0;
  #tiles = 0;
  #listeners = new Set();
  #idleTimer;
  #idleMs;
  #onExpire;

  constructor({ id, ws, nodeId, idleMs, onExpire }) {
    this.id = id;
    this.nodeId = nodeId;
    this.createdAt = Date.now();
    this.#ws = ws;
    this.#idleMs = idleMs;
    this.#onExpire = onExpire;
    ws.on('message', (d) => this.#onMessage(d));
    ws.on('close', () => { this.closed = true; clearTimeout(this.#idleTimer); this.#onExpire?.(this); });
    ws.on('error', () => {});
    this.#arm();
    // Kick off streaming in case the agent waits for us (also sent on each screensize).
    this.#sendCompression();
    this.#sendUnpause();
  }

  get isOpen() { return !this.closed && this.#ws.readyState === 1; }
  get width() { return this.#width; }
  get height() { return this.#height; }
  get tilesReceived() { return this.#tiles; }

  #arm() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close('idle timeout'), this.#idleMs);
    this.#idleTimer.unref?.();
  }

  #onMessage(data) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (b.length > 0 && b[0] === 0x7b) return; // JSON control frame (metadata/consent) - ignore
    this.#acc = this.#acc.length ? Buffer.concat([this.#acc, b]) : b;
    this.#parse();
  }

  #parse() {
    while (this.#acc.length >= 4) {
      const cmd = this.#acc.readUInt16BE(0);
      const size = this.#acc.readUInt16BE(2);
      if (size < 4 || this.#acc.length < size) break;
      const frame = this.#acc.subarray(0, size);
      this.#acc = this.#acc.subarray(size);
      if (cmd === CMD_SCREEN) {
        this.#onScreen(frame.readUInt16BE(4), frame.readUInt16BE(6));
      } else if (cmd === CMD_TILE) {
        this.#onTile(frame.readUInt16BE(4), frame.readUInt16BE(6), frame.subarray(8));
      }
    }
  }

  #onScreen(w, h) {
    if (w !== this.#width || h !== this.#height || !this.#fb) {
      this.#width = w;
      this.#height = h;
      this.#fb = Buffer.alloc(w * h * 4, 0);
    }
    // Re-assert streaming settings after a resize, mirroring the web client.
    this.#sendCompression();
    this.#sendUnpause();
  }

  #onTile(x, y, jpegData) {
    let img;
    try { img = jpeg.decode(jpegData, { useTArray: true, formatAsRGBA: true }); } catch { return; }
    if (!this.#fb) { this.#width = img.width; this.#height = img.height; this.#fb = Buffer.alloc(img.width * img.height * 4, 0); }
    // Blit the tile into the framebuffer at (x, y), clipped to bounds.
    const fbW = this.#width;
    for (let row = 0; row < img.height; row++) {
      const dy = y + row;
      if (dy < 0 || dy >= this.#height) continue;
      const copyW = Math.min(img.width, fbW - x);
      if (copyW <= 0) continue;
      const srcStart = row * img.width * 4;
      const dstStart = (dy * fbW + x) * 4;
      img.data.copy ? img.data.copy(this.#fb, dstStart, srcStart, srcStart + copyW * 4)
                    : this.#fb.set(img.data.subarray(srcStart, srcStart + copyW * 4), dstStart);
    }
    this.#tiles++;
    this.#arm();
    for (const fn of [...this.#listeners]) { try { fn(); } catch {} }
  }

  onTile(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  hasFrame() { return this.#fb != null && this.#tiles > 0; }

  // Encode the current framebuffer as a JPEG, optionally downscaled (nearest-neighbour).
  encodeJpeg({ quality = 70, maxWidth = 1280 } = {}) {
    if (!this.#fb) throw new Error('No frame captured yet');
    let { w, h, data } = { w: this.#width, h: this.#height, data: this.#fb };
    if (maxWidth && w > maxWidth) {
      const scale = maxWidth / w;
      const nw = Math.max(1, Math.round(w * scale));
      const nh = Math.max(1, Math.round(h * scale));
      const out = Buffer.alloc(nw * nh * 4);
      for (let yy = 0; yy < nh; yy++) {
        const sy = Math.min(h - 1, Math.floor(yy / scale));
        for (let xx = 0; xx < nw; xx++) {
          const sx = Math.min(w - 1, Math.floor(xx / scale));
          data.copy(out, (yy * nw + xx) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
        }
      }
      w = nw; h = nh; data = out;
    }
    const enc = jpeg.encode({ data, width: w, height: h }, quality);
    return { base64: enc.data.toString('base64'), width: w, height: h, nativeWidth: this.#width, nativeHeight: this.#height };
  }

  #send(buf) { if (this.isOpen) this.#ws.send(buf); this.#arm?.(); }
  #sendCompression() { this.#send(Buffer.concat([Buffer.from([0, 5, 0, 10, 1, 60]), u16(1024), u16(100)])); } // JPEG q60
  #sendUnpause() { this.#send(Buffer.from([0, 8, 0, 5, 0])); }
  refresh() { this.#send(Buffer.from([0, 6, 0, 4])); }

  // ── Input ───────────────────────────────────────────────────────────────
  #mouse(buttonByte, x, y) { this.#send(Buffer.concat([Buffer.from([0, INPUT.MOUSE, 0, 0x0a, 0x00, buttonByte]), u16(x), u16(y)])); }

  move(x, y) { this.#mouse(MOUSE_BTN.none, x, y); }

  click(x, y, button = 'left', double = false) {
    const b = MOUSE_BTN[button] ?? MOUSE_BTN.left;
    this.move(x, y);
    this.#mouse(b, x, y);              // down
    this.#mouse((b * 2) & 0xff, x, y); // up
    if (double) { this.#mouse(b, x, y); this.#mouse((b * 2) & 0xff, x, y); }
  }

  scroll(x, y, delta) {
    const d = delta < 0 ? (((255 - (Math.abs(delta) >> 8)) << 8) | (255 - (Math.abs(delta) & 0xff))) : delta;
    this.#send(Buffer.concat([Buffer.from([0, INPUT.MOUSE, 0, 0x0c, 0x00, 0x00]), u16(x), u16(y), u16(d)]));
  }

  typeText(str) {
    for (const ch of str) {
      const code = ch.codePointAt(0);
      this.#send(Buffer.concat([Buffer.from([0, INPUT.KEYUNICODE, 0, 7, 0]), u16(code)])); // down
      this.#send(Buffer.concat([Buffer.from([0, INPUT.KEYUNICODE, 0, 7, 1]), u16(code)])); // up
    }
  }

  // Press a key by Windows virtual-key code (down then up). extended for nav keys.
  keyVk(vk, extended = false) {
    this.#send(Buffer.from([0, INPUT.KEY, 0, 6, extended ? 3 : 0, vk])); // down
    this.#send(Buffer.from([0, INPUT.KEY, 0, 6, extended ? 4 : 1, vk])); // up
  }

  ctrlAltDel() { this.#send(Buffer.from([0, INPUT.CTRLALTDEL, 0, 4])); }

  close(reason = 'closed by user') {
    this.closedReason = reason;
    clearTimeout(this.#idleTimer);
    try { this.#ws.close(); } catch {}
  }
}

// Common Windows virtual-key codes for mesh_desktop_key.
export const VK = {
  enter: 0x0d, tab: 0x09, escape: 0x1b, esc: 0x1b, backspace: 0x08, delete: 0x2e,
  space: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23,
  pageup: 0x21, pagedown: 0x22, win: 0x5b, ctrl: 0x11, alt: 0x12, shift: 0x10,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76, f8: 0x77,
  f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
};
const EXTENDED = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'delete', 'win']);

export class DesktopManager {
  #sessions = new Map();
  #client;
  #idleMs;
  #max;

  constructor({ client, idleMinutes = 10, maxSessions = 3 }) {
    this.#client = client;
    this.#idleMs = idleMinutes * 60_000;
    this.#max = maxSessions;
  }

  get(id) {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`No desktop session '${id}'. It may have been closed or timed out. Use mesh_desktop_list.`);
    return s;
  }

  list() {
    return [...this.#sessions.values()].map((s) => ({
      session_id: s.id, node_id: s.nodeId, open: s.isOpen,
      width: s.width, height: s.height, tiles: s.tilesReceived,
      age_seconds: Math.round((Date.now() - s.createdAt) / 1000),
    }));
  }

  async open(nodeId) {
    if (this.#sessions.size >= this.#max) throw new Error(`Too many open desktop sessions (max ${this.#max}). Close one with mesh_desktop_close.`);
    const ws = await this.#client.openRelay(nodeId, 2);
    const id = `desk_${crypto.randomBytes(5).toString('hex')}`;
    const session = new DesktopSession({
      id, ws, nodeId, idleMs: this.#idleMs,
      onExpire: (s) => { if (this.#sessions.get(s.id) === s) this.#sessions.delete(s.id); },
    });
    this.#sessions.set(id, session);
    return session;
  }

  // Stateless single screenshot: open, wait for a settled frame, encode, close.
  async screenshot(nodeId, opts = {}) {
    const ws = await this.#client.openRelay(nodeId, 2);
    const session = new DesktopSession({ id: 'oneshot', ws, nodeId, idleMs: 60_000, onExpire: () => {} });
    try {
      await waitForFrame(session, opts);
      if (!session.hasFrame()) throw new Error('No desktop frame received (no active console session to capture, or view denied).');
      return session.encodeJpeg(opts);
    } finally {
      session.close();
    }
  }

  closeAll() {
    for (const s of this.#sessions.values()) s.close('server shutdown');
    this.#sessions.clear();
  }
}

export const vkFor = (key) => {
  const k = String(key).toLowerCase();
  return { vk: VK[k], extended: EXTENDED.has(k) };
};

// Resolve once tiles stop arriving for quietMs after the first frame, or maxMs elapses.
export function waitForFrame(session, { quietMs = 700, firstMs = 8_000, maxMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let timer;
    const done = () => { off(); clearTimeout(timer); clearTimeout(hard); resolve(); };
    const off = session.onTile(() => { clearTimeout(timer); timer = setTimeout(done, quietMs); });
    timer = setTimeout(done, firstMs);
    const hard = setTimeout(done, maxMs);
    timer.unref?.(); hard.unref?.();
  });
}
