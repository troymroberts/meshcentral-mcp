import { vkFor } from './desktop.js';

export const MAX_SEQUENCE_STEPS = 25;

// Run a fixed list of desktop steps with no model turn in between, failing
// closed: the first failed expectation (or unknown key, or closed session)
// stops the run and nothing after it is sent. Each input step waits for its
// own repaint exactly like the single-action tools, so a following clipboard
// read sees the result of the input before it.
//
// steps: { action: 'click', x, y, button?, double? } | { action: 'type', text }
//      | { action: 'key', key } | { action: 'hotkey', keys }
//      | { action: 'read_clipboard', expect?, label? }
// readClip: async () => string | null
//
// Resolves to { ok, steps: [{ i, action, detail, value? }], clipboard: [{ label, value }], failure? }.
export async function runSequence({ session, steps, readClip, settle = defaultSettle }) {
  const log = [];
  const clipboard = [];
  const fail = (i, step, reason) => ({ ok: false, steps: log, clipboard, failure: { step: i + 1, action: step.action, reason } });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!session.isOpen) return fail(i, step, 'desktop session is closed');
    switch (step.action) {
      case 'click':
        await session.click(step.x, step.y, step.button ?? 'left', step.double ?? false);
        await settle(session);
        log.push({ i: i + 1, action: 'click', detail: `${step.double ? 'double-' : ''}${step.button ?? 'left'} at (${step.x},${step.y})` });
        break;
      case 'type':
        session.typeText(step.text);
        await settle(session);
        log.push({ i: i + 1, action: 'type', detail: `${step.text.length} chars` });
        break;
      case 'key': {
        const { vk, extended } = vkFor(step.key);
        if (vk == null) return fail(i, step, `unknown key '${step.key}'`);
        session.keyVk(vk, extended);
        await settle(session);
        log.push({ i: i + 1, action: 'key', detail: step.key });
        break;
      }
      case 'hotkey': {
        const specs = step.keys.map((k) => ({ name: k, ...vkFor(k) }));
        const bad = specs.filter((x) => x.vk == null).map((x) => x.name);
        if (bad.length) return fail(i, step, `unknown key(s): ${bad.join(', ')}`);
        session.hotkey(specs);
        await settle(session);
        log.push({ i: i + 1, action: 'hotkey', detail: step.keys.join('+') });
        break;
      }
      case 'read_clipboard': {
        const value = await readClip();
        const label = step.label ?? `step ${i + 1}`;
        clipboard.push({ label, value });
        log.push({ i: i + 1, action: 'read_clipboard', detail: label, value });
        if (value == null) return fail(i, step, 'no clipboard data returned');
        if (step.expect !== undefined && value !== step.expect) {
          return fail(i, step, `clipboard did not match the expected value (expected ${JSON.stringify(step.expect)})`);
        }
        break;
      }
      default:
        return fail(i, step, `unknown action '${step.action}'`);
    }
  }
  return { ok: true, steps: log, clipboard };
}

function defaultSettle(session) {
  return session.capture({ watch: true, settleMs: 300, maxMs: 8_000 });
}
