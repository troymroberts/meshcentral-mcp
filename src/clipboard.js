// Read a device's clipboard through the agent ('getclip'). Resolves to the
// clipboard text, or null when the agent returns nothing in time (clipboard
// empty, no desktop session, or the clipboard module missing).
export async function readClipboard(client, nodeId, timeoutMs = 15_000) {
  client.sendRaw({ action: 'msg', type: 'getclip', nodeid: nodeId, tag: 3 }).catch(() => {});
  try {
    const res = await client.waitForMessage(
      (m) => m.action === 'msg' && m.type === 'getclip' && m.nodeid === nodeId && m.data !== undefined,
      timeoutMs
    );
    return typeof res.data === 'string' ? res.data : String(res.data);
  } catch {
    return null;
  }
}
