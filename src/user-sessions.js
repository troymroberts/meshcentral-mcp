// Windows user sessions on a device, as the Mesh Agent reports them ('userSessions',
// the same call MeshCentral's web viewer makes to offer a session choice). The KVM
// attaches to the console session unless the viewer passes a terminal-session id
// (tsid) in its connection options, so this is how a remote-desktop (RDP) user's
// screen is reached without switching the console and bumping them.

// Raw agent data: { "<id>": { SessionId, StationName, State, Username?, Domain? } }.
export function normalizeSessions(data) {
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).map(([key, s]) => ({
    tsid: Number(s?.SessionId ?? key),
    station: s?.StationName ?? '',
    state: s?.State ?? '',
    user: s?.Username ? (s.Domain ? `${s.Domain}\\${s.Username}` : s.Username) : null,
    console: /^console$/i.test(s?.StationName ?? ''),
    remote: /^rdp-/i.test(s?.StationName ?? ''),
  })).filter((s) => Number.isInteger(s.tsid)).sort((a, b) => a.tsid - b.tsid);
}

// Resolves to the normalized list, or null when the agent does not answer in time
// (non-Windows agent, old agent, or the device is busy).
export async function listUserSessions(client, nodeId, timeoutMs = 15_000) {
  const tag = Math.floor(Math.random() * 1e9);
  client.sendRaw({ action: 'msg', type: 'userSessions', nodeid: nodeId, tag }).catch(() => {});
  try {
    const res = await client.waitForMessage(
      (m) => m.action === 'msg' && m.type === 'userSessions' && m.nodeid === nodeId && m.data !== undefined,
      timeoutMs
    );
    return normalizeSessions(res.data);
  } catch {
    return null;
  }
}

// One line per session, for tool text.
export function describeSessions(list) {
  return list.map((s) => `tsid ${s.tsid}: ${s.station || '?'}${s.user ? ` (${s.user})` : ''}, ${s.state}`
    + (s.console ? ' [console]' : '') + (s.remote ? ' [remote desktop]' : '')).join('\n');
}

// When the caller did not choose a session: a hint if the console is not where the
// user is (an Active RDP session while the console is merely Connected or absent).
export function sessionHint(list) {
  if (!list || list.length === 0) return '';
  const consoleActive = list.some((s) => s.console && s.state === 'Active');
  const others = list.filter((s) => !s.console && s.state === 'Active');
  if (consoleActive || others.length === 0) return '';
  return `\nNote: the console has no active user, but ${others.map((s) => `tsid ${s.tsid} (${s.station}${s.user ? `, ${s.user}` : ''})`).join(', ')} `
    + `${others.length > 1 ? 'are' : 'is'} active. To see that screen without disturbing the user, reopen with tsid=${others[0].tsid}.`;
}
