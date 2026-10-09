import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import jpeg from 'jpeg-js';
import { DesktopSession, noFrameMessage } from '../src/desktop.js';

// Minimal stand-in for a relay WebSocket: records what the session sends and
// lets the test deliver binary or text frames.
class FakeWs extends EventEmitter {
  readyState = 1;
  sent = [];
  send(buf) { this.sent.push(Buffer.from(buf)); }
  close() { this.readyState = 3; this.emit('close'); }
  binary(buf) { this.emit('message', buf, true); }
  text(str) { this.emit('message', Buffer.from(str), false); }
}

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const frame = (cmd, payload) => Buffer.concat([u16(cmd), u16(4 + payload.length), payload]);
const jumbo = (inner) => Buffer.concat([u16(27), u16(8), Buffer.from([0, (inner.length >> 16) & 0xff, (inner.length >> 8) & 0xff, inner.length & 0xff]), inner]);

function solidJpeg(w, h, rgb) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return jpeg.encode({ data, width: w, height: h }, 90).data;
}

// A