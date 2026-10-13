import { z } from 'zod';
import { agentRisk } from '../agent-guard.js';
import { waitForFrame, vkFor, VK, noFrameMessage, DEFAULT_MAX_WIDTH } from '../desktop.js';
import { textResult, errorResult } from '../safety.js';

// X — remote desktop (KVM)
export default function register(ctx) {
  const { define, desktops, resolveNodeId, imageResult } = ctx;

  // ── Remote desktop (KVM) ──────────────────────────────────────────────────
  // Screenshot is RF (remote view). Opening a control session and sending input
  // are X (remote control of the console).
  define({
    name: 'mesh_desktop_screenshot', tier: 'RF', title: 'Desktop screenshot',
    description:
      'Capture a screenshot of a device desktop as a JPEG image. Pass session_id to grab the current frame of an ' +
      'open session, or node_id to take a one-off capture. Returns the image plus its native pixel dimensions.',
    schema: {
      node_id: z.string().optional().describe('Device node ID or name (for a one-off capture; must be online)'),
      session_id: z.string().optional().describe('Open desktop session to re-capture instead'),
      display: z.number().int().optional().describe('Display/monitor number to capture (one-off only; 65535 = all). Omit for the current one.'),
      max_width: z.number().int().positive().optional().describe('Downscale so width <= this (default 960; pass a larger value (up to native 1920) to read fine print)'),
    },
    handler: async ({ node_id, session_id, display, max_width }) => {
      const maxWidth = max_width ?? DEFAULT_MAX_WIDTH;
      if (session_id) {
        const s = desktops.get(session_id);
        await s.capture({ maxMs: 8_000 }); // burst if idle-paused; freshen if live
        if (!s.hasFrame()) return errorResult('No frame available for that session yet.');
        return imageResult(s.encodeJpeg({ maxWidth }), `Desktop (session ${session_id}):`, s);
      }
      if (!node_id) return errorResult('Provide node_id (one-off) or session_id (open session).');
      const enc = await desktops.screenshot(await resolveNodeId(node_id), { maxWidth, display });
      return imageResult(enc, `Desktop of ${node_id}:`);
    },
  });

  define({
    name: 'mesh_desktop_open', tier: 'X', title: 'Open desktop session',
    description:
      'Open an interactive remote-desktop (KVM) session to a device console and return a session_id plus the first ' +
      'screenshot. Use mesh_desktop_click / _type / _key / _scroll to control it, mesh_desktop_screenshot to re-capture.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id }) => `Open remote desktop control of ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      display: z.number().int().optional().describe('Display/monitor number to view (65535 = all). Omit for the primary.'),
    },
    handler: async ({ node_id, display }) => {
      const session = await desktops.open(await resolveNodeId(node_id));
      await waitForFrame(session, { requireNew: false, maxMs: 10_000 });
      if (display != null) { session.setDisplay(display); await waitForFrame(session, { maxMs: 6_000 }); }
      if (!session.hasFrame()) {
        const msg = noFrameMessage(session);
        session.close('no frame');
        return errorResult(msg);
      }
      session.armRethrottle(); // stay full rate; drop to idle only after a quiet spell
      const cal = await session.calibrate(); // measure RTT + frame cost; sizes capture waits
      const calNote = cal.rttMs != null
        ? `\nLink: RTT ~${cal.rttMs}ms, frame ~${cal.frameCostMs}ms, est. ~${session.estimatedActionMs()}ms per captured action.`
        : '';
      // Keep session_id token clean (no trailing punctuation) so callers that parse
      // `session_id=(\S+)` capture only the id.
      return imageResult(session.encodeJpeg({ maxWidth: DEFAULT_MAX_WIDTH }), `Desktop session opened. session_id=${session.id}${calNote}`, session);
    },
  });

  // Let the input land, then stream one full frame (unpause→refresh→settle→re-pause)
  // so the model sees the effect without the device streaming while idle.
  // Watch for the effect's own tiles rather than waiting a fixed time: a fast
  // effect (typing) returns in a few hundred ms, a slow one (app launch) is caught
  // when its tiles appear, and a genuine no-op falls back to a forced refresh.
  async function afterInput(session) {
    await session.capture({ watch: true, settleMs: 300, maxMs: 8_000 });
    return session.encodeJpeg({ maxWidth: DEFAULT_MAX_WIDTH });
  }

  define({
    name: 'mesh_desktop_click', tier: 'X', title: 'Desktop click',
    change: () => false, // individual inputs stay in the local record only; session open/close go to the device log
    description: 'Click (or double-click) at native pixel coordinates in a desktop session, then return a fresh screenshot.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, x, y, button }) => `${button || 'left'}-click at (${x},${y}) in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID from mesh_desktop_open'),
      x: z.number().int().min(0).describe('X in native pixels'),
      y: z.number().int().min(0).describe('Y in native pixels'),
      button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
      double: z.boolean().optional().describe('Double-click'),
    },
    handler: async ({ session_id, x, y, button, double }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      await s.click(x, y, button ?? 'left', double ?? false);
      return imageResult(await afterInput(s), `After ${double ? 'double-' : ''}${button ?? 'left'}-click at (${x},${y}):`);
    },
  });

  define({
    name: 'mesh_desktop_move', tier: 'X', title: 'Desktop mouse move',
    change: () => false, // individual inputs stay in the local record only; session open/close go to the device log
    description: 'Move the mouse to native pixel coordinates (no click).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, x, y }) => `Move mouse to (${x},${y}) in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID'),
      x: z.number().int().min(0), y: z.number().int().min(0),
    },
    handler: async ({ session_id, x, y }) => {
      const s = desktops.get(session_id);
      s.move(x, y);
      return textResult(`Moved to (${x},${y}).`);
    },
  });

  define({
    name: 'mesh_desktop_type', tier: 'X', title: 'Desktop type text',
    change: () => false, // individual inputs stay in the local record only; session open/close go to the device log
    description: 'Type a string into the desktop session (sent as Unicode key events), then return a screenshot.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, text }) => `Type into desktop ${session_id}: ${text}`,
    agentRisk: async ({ text }) => agentRisk(text),
    schema: {
      session_id: z.string().describe('Session ID'),
      text: z.string().describe('Text to type'),
    },
    handler: async ({ session_id, text }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      s.typeText(text);
      return imageResult(await afterInput(s), `After typing ${JSON.stringify(text)}:`);
    },
  });

  define({
    name: 'mesh_desktop_key', tier: 'X', title: 'Desktop key press',
    change: () => false, // individual inputs stay in the local record only; session open/close go to the device log
    description: `Press a special key by name (then screenshot). Known: ${Object.keys(VK).join(', ')}.`,
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, key }) => `Press ${key} in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID'),
      key: z.string().describe('Key name (e.g. enter, tab, escape, win, f5, up)'),
    },
    handler: async ({ session_id, key }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      const { vk, extended } = vkFor(key);
      if (vk == null) return errorResult(`Unknown key '${key}'. Known: ${Object.keys(VK).join(', ')}`);
      s.keyVk(vk, extended);
      return imageResult(await afterInput(s), `After pressing ${key}:`);
    },
  });

  define({
    name: 'mesh_desktop_hotkey', tier: 'X', title: 'Desktop hotkey',
    change: () => false, // individual inputs stay in the local record only; session open/close go to the device log
    description:
      'Press a key chord in a desktop session (modifiers held while the final key is pressed), then screenshot. ' +
      'Give keys in order, e.g. ["ctrl","s"], ["alt","f4"], ["ctrl","shift","escape"], ["win","d"]. ' +
      'Modifiers: ctrl, alt, shift, win. Other keys: single characters or names (enter, tab, f4, delete, ...).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, keys }) => `Press ${keys.join('+')} in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID'),
      keys: z.array(z.string()).min(1).describe('Keys in press order; modifiers first (e.g. ["ctrl","s"])'),
    },
    handler: async ({ session_id, keys }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      const specs = keys.map((k) => ({ name: k, ...vkFor(k) }));
      const bad = specs.filter((x) => x.vk == null).map((x) => x.name);
      if (bad.length) return errorResult(`Unknown key(s): ${bad.join(', ')}`);
      s.hotkey(specs);
      return imageResult(await afterInput(s), `After ${keys.join('+')}:`, s);
    },
  });

  define({
    name: 'mesh_desktop_scroll', tier: 'X', title: 'Desktop scroll',
    change: () => false, // individual inputs stay in the local record only; session open/close go to the device log
    description: 'Scroll the mouse wheel at native pixel coordinates (positive = up), then screenshot.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, amount }) => `Scroll ${amount} in desktop ${session_id}`,
    schema: {
      session_id: z.string().describe('Session ID'),
      x: z.number().int().min(0), y: z.number().int().min(0),
      amount: z.number().int().describe('Wheel delta (positive = up, negative = down; e.g. 360)'),
    },
    handler: async ({ session_id, x, y, amount }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      s.scroll(x, y, amount);
      return imageResult(await afterInput(s), `After scroll ${amount} at (${x},${y}):`);
    },
  });

  define({
    name: 'mesh_desktop_set_display', tier: 'X', title: 'Select desktop monitor',
    change: () => false, // individual inputs stay in the local record only; session open/close go to the device log
    description: 'Switch which monitor an open desktop session shows (use the display numbers from a screenshot; 65535 = all).',
    schema: {
      session_id: z.string().describe('Session ID'),
      display: z.number().int().describe('Display/monitor number (65535 = all)'),
    },
    handler: async ({ session_id, display }) => {
      const s = desktops.get(session_id);
      if (!s.isOpen) return errorResult(`Desktop ${session_id} is closed.`);
      s.setDisplay(display);
      await s.capture({ maxMs: 6_000 });
      return imageResult(s.encodeJpeg({ maxWidth: DEFAULT_MAX_WIDTH }), `Switched to display ${display}:`, s);
    },
  });

  define({
    name: 'mesh_desktop_list', tier: 'R', title: 'List desktop sessions',
    description: 'List open remote-desktop sessions.',
    handler: async () => textResult(desktops.list()),
  });

  define({
    name: 'mesh_desktop_close', tier: 'X', title: 'Close desktop session',
    description: 'Close an open remote-desktop session.',
    schema: { session_id: z.string().describe('Session ID') },
    handler: async ({ session_id }) => {
      desktops.get(session_id).close('closed by user');
      return textResult(`Desktop ${session_id} closed.`);
    },
  });
}
