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
const CMD_DISPLAYS = 11;
const CMD_MESSAGE = 17;      // MNG_KVM_MESSAGE: text (consent prompts, status)
const CMD_KEYSTATE = 18;     // NumLock=1, ScrollLock=2, CapsLock=4
const CMD_ALERT = 65;        // agent error/alert text ('.'-prefixed = debug only)
const CMD_DISPLAY_INFO = 82; // per-display {id, x, y, w, h} records, 10 bytes each
const CMD_INPUT_LOCK = 87;   // remote input locked (our input is ignored)
const CMD_JUMBO = 27;        // 8-byte header wrapping a frame larger than 65535 bytes
const MAX_NOTICES = 20;

// Image encoding we request from the agent (compression cmd byte 4):
// 1=JPEG, 2=PNG, 3=TIFF, 4=WebP. We pin JPEG because the tile decoder below is
// jpeg-js only; the agent sends WebP/PNG/TIFF only if a client asks for it, so
// this stays JPEG unless the decoder is extended to match.
const IMAGE_JPEG = 1;

// Agent frame interval (compression cmd, ms between frame updates). Normal rate
// while capturing or while a human co-views; a slow idle rate when the agent is
// the only viewer, so the device isn't encoding a full-rate stream nobody watches.
// (Unlike pausing, which wedged the shared KVM slave, this only changes the rate.)
const FRAME_MS_ACTIVE = 100;

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
  #displays = null;      // { '0': 'Display 0', '65535': 'All Displays', ... }
  #selectedDisplay = null;
  #viewers = 1;          // viewers attached to this device's KVM (incl. us), from metadata
  #notices = [];         // agent alerts/messages not yet reported to the caller
  #inputLocked = null;   // true when the agent reports remote input is locked
  #keyState = 0;         // 1 NumLock, 2 ScrollLock, 4 CapsLock
  #displayInfo = null;   // { id: { x, y, w, h } } from cmd 82
  #frameMs = FRAME_MS_ACTIVE; // frame interval last requested from the agent
  #idleFrameMs;          // interval to use when the agent is the only viewer (0 = never throttle)
  #rethrottleTimer = null; // fires after a quiet spell to drop back to the idle rate

  constructor({ id, ws, nodeId, idleMs, onExpire, idleFrameMs = 0 }) {
    this.id = id;
    this.nodeId = nodeId;
    this.#idleFrameMs = idleFrameMs;
    this.createdAt = Date.now();
    this.#ws = ws;
    this.#idleMs = idleMs;
    this.#onExpire = onExpire;
    ws.on('message', (d, isBinary) => this.#onMessage(d, isBinary));
    ws.on('close', () => { this.closed = true; clearTimeout(this.#idleTimer); this.#onExpire?.(this); });
    ws.on('error', () => {});
    this.#arm();
    // Kick off streaming. The agent emits screensize then tiles once unpaused, but
    // if a KVM slave is already running (another viewer attached) a newly joined
    // tunnel gets no keyframe on a static screen, and a refresh sent before the
    // slave has attached is dropped. So re-send refresh until the first tile lands.
    this.#sendCompression();
    this.#sendUnpause();
    this.requestDisplays();
    this.#primeFrames();
  }

  #primeFrames(attempt = 0) {
    if (this.closed || this.#tiles > 0 || attempt > 8) return;
    this.refresh();
    const timer = setTimeout(() => this.#primeFrames(attempt + 1), 600);
    timer.unref?.();
  }

  get isOpen() { return !this.closed && this.#ws.readyState === 1; }
  get width() { return this.#width; }
  get height() { return this.#height; }
  get tilesReceived() { return this.#tiles; }
  get displays() { return this.#displays; }
  get selectedDisplay() { return this.#selectedDisplay; }
  get viewers() { return this.#viewers; }
  get inputLocked() { return this.#inputLocked; }
  get capsLock() { return (this.#keyState & 4) !== 0; }
  get displayInfo() { return this.#displayInfo; }

  // Return and clear agent alerts/messages received since the last call.
  takeNotices() { const n = this.#notices; this.#notices = []; return n; }

  #notice(kind, text) {
    this.#notices.push({ kind, text });
    if (this.#notices.length > MAX_NOTICES) this.#notices.shift();
  }

  #arm() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => this.close('idle timeout'), this.#idleMs);
    this.#idleTimer.unref?.();
  }

  // Control JSON arrives as WebSocket *text* frames; KVM commands as *binary*.
  // Classify by frame type like MeshCentral's own client: sniffing for a leading
  // '{' would misroute a split binary chunk that happens to start with 0x7B and
  // desync the stream.
  #onMessage(data, isBinary) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (isBinary === false) { this.#onControl(b); return; }
    this.#acc = this.#acc.length ? Buffer.concat([this.#acc, b]) : b;
    this.#parse();
  }

  // Control channel (102938): the agent announces viewer metadata when tunnels
  // join/leave this device's KVM. Track the count so a caller can see when a
  // human (e.g. the MeshCentral UI) is co-viewing the same desktop.
  #onControl(buf) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (msg.ctrlChannel !== '102938') return;
    if (msg.type === 'metadata' && msg.users && typeof msg.users === 'object') {
      this.#viewers = Object.values(msg.users).reduce((a, n) => a + (typeof n === 'number' ? n : 1), 0) || 1;
      if (this.#viewers > 1) {
        // A human joined: their client sets its own (full) rate when it connects;
        // don't send ours over it. Track that the slave is no longer throttled.
        this.#frameMs = FRAME_MS_ACTIVE;
      } else {
        this.throttle(); // back to agent-only: slow the stream down again
      }
    }
  }

  #parse() {
    while (this.#acc.length >= 4) {
      const cmd = this.#acc.readUInt16BE(0);
      const size = this.#acc.readUInt16BE(2);

      // Jumbo frame: any command whose payload exceeds the 16-bit size field
      // (e.g. a full-screen JPEG tile on a busy screen, >65535 bytes) is wrapped
      // in an 8-byte header [27][8][_][size:24][...]. The real 24-bit length is at
      // bytes 5-7; the complete inner frame follows the 8-byte header. Missing this
      // desyncs the whole stream and freezes the framebuffer.
      if (cmd === CMD_JUMBO && size === 8) {
        if (this.#acc.length < 8) break;
        const inner = (this.#acc[5] << 16) | (this.#acc[6] << 8) | this.#acc[7];
        const total = 8 + inner;
        if (this.#acc.length < total) break;
        const frame = this.#acc.subarray(8, total);
        this.#acc = this.#acc.subarray(total);
        this.#dispatch(frame.readUInt16BE(0), frame);
        continue;
      }

      if (size < 4 || this.#acc.length < size) break;
      const frame = this.#acc.subarray(0, size);
      this.#acc = this.#acc.subarray(size);
      this.#dispatch(cmd, frame);
    }
  }

  #dispatch(cmd, frame) {
    switch (cmd) {
      case CMD_TILE:
        if (frame.length >= 8) this.#onTile(frame.readUInt16BE(4), frame.readUInt16BE(6), frame.subarray(8));
        break;
      case CMD_SCREEN:
        if (frame.length >= 8) this.#onScreen(frame.readUInt16BE(4), frame.readUInt16BE(6));
        break;
      case CMD_DISPLAYS:
        if (frame.length >= 6) this.#onDisplays(frame);
        break;
      case CMD_MESSAGE:
        this.#notice('message', frame.subarray(4).toString('utf8'));
        break;
      case CMD_ALERT: {
        const text = frame.subarray(4).toString('utf8');
        if (!text.startsWith('.')) this.#notice('alert', text); // '.'-prefixed alerts are debug noise
        break;
      }
      case CMD_KEYSTATE:
        if (frame.length === 5) this.#keyState = frame[4];
        break;
      case CMD_INPUT_LOCK:
        if (frame.length === 5) {
          const locked = frame[4] !== 0;
          if (locked && this.#inputLocked !== true) this.#notice('input-lock', 'Remote input is locked on the device; mouse and keyboard input will be ignored.');
          this.#inputLocked = locked;
        }
        break;
      case CMD_DISPLAY_INFO:
        if (frame.length >= 4 && (frame.length - 4) % 10 === 0) {
          const info = {};
          for (let p = 4; p < frame.length; p += 10) {
            info[frame.readUInt16BE(p)] = {
              x: frame.readUInt16BE(p + 2), y: frame.readUInt16BE(p + 4),
              w: frame.readUInt16BE(p + 6), h: frame.readUInt16BE(p + 8),
            };
          }
          this.#displayInfo = info;
        }
        break;
      default:
        break; // cursor shape (88), touch (14/15), set-display ack (12): not needed
    }
  }

  #onDisplays(frame) {
    const dcount = frame.readUInt16BE(4);
    const displays = {};
    for (let i = 0; i < dcount; i++) {
      const id = frame.readUInt16BE(6 + i * 2);
      displays[id] = id === 65535 ? 'All Displays' : `Display ${id}`;
    }
    this.#selectedDisplay = dcount > 0 ? frame.readUInt16BE(6 + dcount * 2) : null;
    this.#displays = displays;
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
    this.releaseModifiers();
  }

  // Send key-up for Shift/Ctrl/Alt/Win so a chord interrupted mid-press can't
  // leave a modifier held and corrupt every later keystroke (the web client does
  // this on every screen-size change).
  releaseModifiers() {
    for (const vk of [0x10, 0x11, 0x12, 0x5b, 0x5c]) this.#send(Buffer.from([0, INPUT.KEY, 0, 6, 1, vk]));
  }

  #onTile(x, y, jpegData) {
    // We only request JPEG (see IMAGE_JPEG); guard so a non-JPEG tile (e.g. if an
    // agent ignored our request) surfaces a clear reason instead of a blank frame.
    if (jpegData.length < 2 || jpegData[0] !== 0xff || jpegData[1] !== 0xd8) {
      this.#notice('decode', 'Received a non-JPEG desktop tile; this build decodes JPEG only.');
      return;
    }
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
  #sendCompression() { this.#send(Buffer.concat([Buffer.from([0, 5, 0, 10, IMAGE_JPEG, 60]), u16(1024), u16(this.#frameMs)])); } // type=JPEG, quality 60

  #setFrameRate(ms) {
    if (ms === this.#frameMs) return;
    this.#frameMs = ms;
    this.#sendCompression();
  }

  get frameMs() { return this.#frameMs; }

  // Slow the agent's frame rate while we're the only viewer. No-op when a human is
  // co-viewing (they get full-rate video) or when throttling is disabled.
  throttle() {
    clearTimeout(this.#rethrottleTimer);
    this.#rethrottleTimer = null;
    if (this.#idleFrameMs > 0 && this.#viewers <= 1) this.#setFrameRate(this.#idleFrameMs);
  }

  // Stay at full rate now; drop to the idle rate only after a quiet spell. Keeps an
  // active drive loop (capture every second or two) at full rate the whole time,
  // so captures are fast, while still saving bandwidth once the agent goes idle.
  armRethrottle(afterMs = 4000) {
    this.#setFrameRate(FRAME_MS_ACTIVE);
    clearTimeout(this.#rethrottleTimer);
    this.#rethrottleTimer = setTimeout(() => this.throttle(), afterMs);
    this.#rethrottleTimer.unref?.();
  }
  // "Pause=0": tell the agent to (keep) streaming. We never send pause=1: on some
  // agents (observed on Windows Server 2022) pausing the shared KVM slave and then
  // disconnecting wedges it (screen-size but no tiles) for every later viewer until
  // the agent restarts. The session therefore streams continuously while open; to
  // stop the device stream, close the session.
  #sendUnpause() { this.#send(Buffer.from([0, 8, 0, 5, 0])); }
  refresh() { this.#send(Buffer.from([0, 6, 0, 4])); }

  requestDisplays() { this.#send(Buffer.from([0, 0x0b, 0, 4])); }

  setDisplay(n) {
    this.#send(Buffer.concat([Buffer.from([0, 0x0c, 0, 6]), u16(n)]));
    this.#selectedDisplay = n;
  }

  // Force a full repaint of the current screen and wait for it to settle, so the
  // returned frame reflects state at/after this call (not a stale earlier frame).
  // Runs at full frame rate for the burst, then re-throttles if we're alone.
  // Two modes:
  //  - default (watch=false): a plain screenshot. Force a full repaint now and
  //    return as soon as it has arrived and settled (~300ms at full rate).
  //  - watch=true (after an input): do NOT refresh first; wait for the effect's
  //    own tiles so a fast effect returns quickly and a slow one (app launch) is
  //    caught when its tiles appear — no fixed guess. Only a genuine no-op waits
  //    `graceMs` and then forces a refresh so a frame is always returned.
  // Keeps the stream at full rate so each refresh is serviced in ~90ms, not ~1.5s.
  capture({ settleMs = 250, minMs = 120, maxMs = 8_000, watch = false, graceMs = 1500 } = {}) {
    this.armRethrottle();
    const startTiles = this.#tiles;
    if (!watch) this.refresh();
    return new Promise((resolve) => {
      let lastTile = 0;
      let forced = !watch;
      const t0 = Date.now();
      const off = this.onTile(() => { lastTile = Date.now(); });
      const done = () => { off(); clearInterval(iv); this.armRethrottle(); resolve(); };
      const iv = setInterval(() => {
        const now = Date.now();
        const elapsed = now - t0;
        const changed = this.#tiles > startTiles;
        if (elapsed >= maxMs) return done();
        if (changed && elapsed >= minMs && now - lastTile >= settleMs) return done();
        if (!changed && !forced && elapsed >= graceMs) { forced = true; this.refresh(); } // no effect: force one frame
      }, 30);
      iv.unref?.();
    });
  }

  // ── Input ───────────────────────────────────────────────────────────────
  #mouse(buttonByte, x, y) { this.#send(Buffer.concat([Buffer.from([0, INPUT.MOUSE, 0, 0x0a, 0x00, buttonByte]), u16(x), u16(y)])); }

  move(x, y) { this.#mouse(MOUSE_BTN.none, x, y); }

  // Small gaps so Windows registers a real press and a real double-click
  // (back-to-back events can collapse into a single click).
  async click(x, y, button = 'left', double = false) {
    const b = MOUSE_BTN[button] ?? MOUSE_BTN.left;
    const gap = (ms) => new Promise((r) => setTimeout(r, ms));
    this.move(x, y);
    await gap(40);
    this.#mouse(b, x, y);               // press
    await gap(40);
    this.#mouse((b * 2) & 0xff, x, y);  // release
    if (double) {
      await gap(90);
      this.#mouse(b, x, y);
      await gap(40);
      this.#mouse((b * 2) & 0xff, x, y);
    }
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

  // Press a chord: hold each key down in order, then release in reverse
  // (e.g. Ctrl+S, Alt+F4). specs: [{ vk, extended }].
  hotkey(specs) {
    for (const s of specs) this.#send(Buffer.from([0, INPUT.KEY, 0, 6, s.extended ? 3 : 0, s.vk]));
    for (let i = specs.length - 1; i >= 0; i--) {
      const s = specs[i];
      this.#send(Buffer.from([0, INPUT.KEY, 0, 6, s.extended ? 4 : 1, s.vk]));
    }
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
  #idleFrameMs;

  constructor({ client, idleMinutes = 10, maxSessions = 3, idleFrameMs = 2000 }) {
    this.#client = client;
    this.#idleMs = idleMinutes * 60_000;
    this.#max = maxSessions;
    this.#idleFrameMs = idleFrameMs;
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
      viewers: s.viewers, frame_ms: s.frameMs,
      display: s.selectedDisplay, displays: s.displays,
      age_seconds: Math.round((Date.now() - s.createdAt) / 1000),
    }));
  }

  async open(nodeId) {
    if (this.#sessions.size >= this.#max) throw new Error(`Too many open desktop sessions (max ${this.#max}). Close one with mesh_desktop_close.`);
    const ws = await this.#client.openRelay(nodeId, 2);
    const id = `desk_${crypto.randomBytes(5).toString('hex')}`;
    const session = new DesktopSession({
      id, ws, nodeId, idleMs: this.#idleMs, idleFrameMs: this.#idleFrameMs,
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
      if (opts.display != null) session.setDisplay(opts.display);
      await waitForFrame(session, { requireNew: false, maxMs: 10_000 });
      if (!session.hasFrame()) throw new Error(noFrameMessage(session));
      const enc = session.encodeJpeg(opts);
      enc.displays = session.displays;
      enc.selectedDisplay = session.selectedDisplay;
      enc.notices = session.takeNotices();
      return enc;
    } finally {
      session.close();
    }
  }

  closeAll() {
    for (const s of this.#sessions.values()) s.close('server shutdown');
    this.#sessions.clear();
  }
}

// Explain a missing frame using what the agent actually reported, if anything.
export function noFrameMessage(session) {
  const notices = session.takeNotices();
  const said = notices.map((n) => n.text).filter(Boolean).join('; ');
  return said
    ? `No desktop frame received. Agent reported: ${said}`
    : 'No desktop frame received (no active console session to capture, view denied, or another viewer holding the desktop).';
}

export const vkFor = (key) => {
  const k = String(key).toLowerCase();
  if (VK[k] != null) return { vk: VK[k], extended: EXTENDED.has(k) };
  // Single character: letters/digits map to their uppercase char code (VK = ASCII upper).
  if (String(key).length === 1) {
    const vk = String(key).toUpperCase().charCodeAt(0);
    if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5a)) return { vk, extended: false };
  }
  return { vk: undefined, extended: false };
};

// Resolve once tiles stop arriving for quietMs after the first frame, or maxMs elapses.
// Wait for a settled frame that postdates the call. Resolves once:
//   - at least `minMs` has elapsed (let a slow effect begin), AND
//   - at least one new tile has arrived since the call (so the frame is fresh), AND
//   - no tile has arrived for `settleMs` (the screen has stopped changing);
// or `maxMs` elapses as a hard ceiling. Because every capture forces a full
// repaint first, a fresh tile is guaranteed, so this never resolves on a stale
// pre-input frame. `requireNew:false` relaxes the fresh-tile requirement (used
// for the very first frame of a brand-new session, where no refresh preceded).
export function waitForFrame(session, { settleMs = 250, minMs = 120, maxMs = 8_000, requireNew = true } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const startTiles = session.tilesReceived;
    let lastTile = 0;
    const off = session.onTile(() => { lastTile = Date.now(); });
    const iv = setInterval(() => {
      const now = Date.now();
      const elapsed = now - started;
      const gotNew = !requireNew || session.tilesReceived > startTiles;
      const quiet = lastTile !== 0 && now - lastTile >= settleMs;
      if (elapsed >= maxMs || (elapsed >= minMs && gotNew && quiet)) {
        off(); clearInterval(iv); resolve();
      }
    }, 30);
    iv.unref?.();
  });
}
