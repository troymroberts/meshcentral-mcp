import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopSession } from '../src/desktop.js';
import { runSequence } from '../src/desktop-sequence.js';

class FakeWs extends EventEmitter {
  readyState = 1;
  sent = [];
  send(buf) { this.sent.push(Buffer.from(buf)); }
  close() { this.readyState = 3; this.emit('close'); }
}
const mk = () => {
  const ws = new FakeWs();
  const s = new DesktopSession({ id: 't', ws, nodeId: 'n', idleMs: 60_000, onExpire() {} });
  ws.sent.length = 0;
  return { ws, s };
};
const noSettle = async () => {};
// Input frames: mouse = cmd 2, key = cmd 1, unicode key = cmd 85.
const inputs = (ws) => ws.sent.filter((b) => [1, 2, 85].includes(b[1]));
const clips = (...values) => { let i = 0; return async () => values[i++]; };

test('sequence runs every step in order when expectations hold', async () => {
  const { ws, s } = mk();
  const res = await runSequence({
    session: s, settle: noSettle,
    readClip: clips('HRMF-Job Letter', 'TARGET'),
    steps: [
      { action: 'click', x: 10, y: 20 },
      { action: 'hotkey', keys: ['ctrl', 'c'] },
      { action: 'read_clipboard', expect: 'HRMF-Job Letter', label: 'name' },
      { action: 'type', text: 'TARGET' },
      { action: 'read_clipboard', expect: 'TARGET', label: 'field' },
    ],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.clipboard.map((c) => c.label), ['name', 'field']);
  assert.ok(inputs(ws).length > 0);
  s.close();
});

test('a clipboard mismatch stops the run and sends nothing after it', async () => {
  const { ws, s } = mk();
  const res = await runSequence({
    session: s, settle: noSettle,
    readClip: clips('HRMF-Something Else'),
    steps: [
      { action: 'read_clipboard', expect: 'HRMF-Job Letter' },
      { action: 'type', text: 'SHOULD NOT BE TYPED' },
      { action: 'click', x: 226, y: 639 },
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(res.failure.step, 1);
  assert.match(res.failure.reason, /did not match/);
  assert.equal(inputs(ws).length, 0, 'no input after the failed check');
  s.close();
});

test('an empty clipboard (e.g. a surprise dialog stole focus) fails closed', async () => {
  const { ws, s } = mk();
  const res = await runSequence({
    session: s, settle: noSettle,
    readClip: clips(null),
    steps: [{ action: 'read_clipboard' }, { action: 'click', x: 1, y: 1 }],
  });
  assert.equal(res.ok, false);
  assert.match(res.failure.reason, /no clipboard data/);
  assert.equal(inputs(ws).length, 0);
  s.close();
});

test('an unknown key stops the run before sending it', async () => {
  const { ws, s } = mk();
  const res = await runSequence({ session: s, settle: noSettle, readClip: clips(), steps: [{ action: 'key', key: 'nosuchkey' }, { action: 'click', x: 1, y: 1 }] });
  assert.equal(res.ok, false);
  assert.match(res.failure.reason, /unknown key/);
  assert.equal(inputs(ws).length, 0);
  s.close();
});
