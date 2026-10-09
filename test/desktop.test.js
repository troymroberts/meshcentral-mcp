import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import jpeg from 'jpeg-js';
import { DesktopSession, noFrameMessage, vkFor, VK } from '../src/desktop.js';

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

const screen = (w, h) => frame(7, Buffer.concat([u16(w), u16(h)]));
const tile = (x, y, jpg) => frame(3, Buffer.concat([u16(x), u16(y), jpg]));
const mk = (ws) => new DesktopSession({ id: 't', ws, nodeId: 'n', idleMs: 60_000, onExpire() {} });

test('composites a jumbo-wrapped full-screen tile and encodes it', () => {
  const ws = new FakeWs();
  const s = mk(ws);
  ws.binary(screen(64, 48));
  // A 64x48 red tile; encoded JPEG wrapped as a jumbo frame.
  ws.binary(jumbo(tile(0, 0, solidJpeg(64, 48, [200, 30, 30]))));
  assert.equal(s.tilesReceived, 1, 'jumbo-wrapped tile decoded');
  assert.ok(s.hasFrame());
  const enc = s.encodeJpeg({ maxWidth: 64 });
  assert.equal(enc.nativeWidth, 64);
  assert.equal(enc.nativeHeight, 48);
  // Decodes back to a mostly-red image.
  const back = jpeg.decode(Buffer.from(enc.base64, 'base64'), { useTArray: true });
  assert.ok(back.data[0] > 150 && back.data[1] < 90, `expected red, got ${back.data[0]},${back.data[1]},${back.data[2]}`);
  s.close();
});

test('a frame right after a jumbo tile still parses (no desync)', () => {
  const ws = new FakeWs();
  const s = mk(ws);
  ws.binary(screen(64, 48));
  ws.binary(Buffer.concat([jumbo(tile(0, 0, solidJpeg(64, 48, [10, 10, 10]))), frame(87, Buffer.from([1]))]));
  assert.equal(s.tilesReceived, 1);
  assert.equal(s.inputLocked, true, 'input-lock frame after the jumbo was parsed');
  s.close();
});

test('partial tiles paint into the framebuffer at their offset', () => {
  const ws = new FakeWs();
  const s = mk(ws);
  ws.binary(screen(32, 32));
  ws.binary(tile(0, 0, solidJpeg(32, 32, [0, 0, 200])));   // full blue background
  ws.binary(tile(0, 0, solidJpeg(16, 16, [0, 200, 0])));   // green patch top-left
  const enc = s.encodeJpeg({ maxWidth: 32 });
  const back = jpeg.decode(Buffer.from(enc.base64, 'base64'), { useTArray: true });
  const px = (x, y) => back.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 3);
  assert.ok(px(4, 4)[1] > 120, 'top-left is green');
  assert.ok(px(28, 28)[2] > 120, 'bottom-right stayed blue');
  s.close();
});

test('control frames arrive as text, not binary', () => {
  const ws = new FakeWs();
  const s = mk(ws);
  ws.text(JSON.stringify({ ctrlChannel: '102938', type: 'metadata', users: { 'user//a': 1, 'user//b': 1 } }));
  assert.equal(s.viewers, 2);
  s.close();
});

test('noFrameMessage includes agent-reported text when present', () => {
  const ws = new FakeWs();
  const s = mk(ws);
  ws.binary(frame(65, Buffer.from('No active console session', 'utf8')));
  assert.match(noFrameMessage(s), /No active console session/);
  // and falls back to a generic hint when the agent said nothing
  assert.match(noFrameMessage(mk(new FakeWs())), /no active console session|view denied/i);
  s.close();
});

test('screen-size change releases modifier keys', () => {
  const ws = new FakeWs();
  const s = mk(ws);
  ws.sent.length = 0;
  ws.binary(screen(80, 60));
  // Expect key-up (INPUT.KEY=1, up=1) for Shift/Ctrl/Alt/LWin/RWin.
  const ups = ws.sent.filter((b) => b.length === 6 && b[1] === 1 && b[4] === 1).map((b) => b[5]);
  for (const vk of [0x10, 0x11, 0x12, 0x5b, 0x5c]) assert.ok(ups.includes(vk), `released vk ${vk}`);
  s.close();
});

test('vkFor maps names, single chars, and marks extended keys', () => {
  assert.equal(vkFor('enter').vk, VK.enter);
  assert.equal(vkFor('ENTER').vk, VK.enter);
  assert.equal(vkFor('up').extended, true);
  assert.equal(vkFor('s').vk, 0x53);
  assert.equal(vkFor('7').vk, 0x37);
  assert.equal(vkFor('nope').vk, undefined);
});
test('throttles frame rate when alone, lifts it for a co-viewer, restores after', () => {
  const ws = new FakeWs();
  const s = new DesktopSession({ id: 't', ws, nodeId: 'n', idleMs: 60_000, onExpire() {}, idleFrameMs: 2000 });
  const lastRate = () => {
    const c = ws.sent.filter((b) => b.length === 10 && b[1] === 5).pop(); // compression cmd
    return c ? c.readUInt16BE(8) : null;
  };
  s.throttle();
  assert.equal(s.frameMs, 2000);
  assert.equal(lastRate(), 2000, 'agent asked for the slow interval');
  ws.text(JSON.stringify({ ctrlChannel: '102938', type: 'metadata', users: { 'user//a': 1, 'user//b': 1 } }));
  assert.equal(s.frameMs, 100, 'co-viewer present: not throttled');
  ws.text(JSON.stringify({ ctrlChannel: '102938', type: 'metadata', users: { 'user//a': 1 } }));
  assert.equal(s.frameMs, 2000, 'alone again: re-throttled');
  assert.equal(lastRate(), 2000);
  s.close();
});

test('idleFrameMs 0 disables throttling', () => {
  const ws = new FakeWs();
  const s = new DesktopSession({ id: 't', ws, nodeId: 'n', idleMs: 60_000, onExpire() {}, idleFrameMs: 0 });
  s.throttle();
  assert.equal(s.frameMs, 100);
  s.close();
});
