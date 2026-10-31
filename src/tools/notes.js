import os from 'os';
import { z } from 'zod';
import { textResult, errorResult, sanitizeText } from '../safety.js';

// Server-side notes (the mcpnotes MeshCentral plugin, plugin/mcpnotes). Markdown
// files about clients, devices and users stored in MeshCentral's database and
// scoped by MeshCentral rights; not shown in the web UI. Paths follow the
// per-client folder layout: <Client>/servers.md, <Client>/devices/<device>.md,
// <Client>/users/<user>.md, plus shared top-level notes (e.g. security/<topic>.md).
export default function register(ctx) {
  const { define, client, resolveNodeId, meshId } = ctx;
  const via = `meshcentral-mcp (${safeUser()})`;

  function safeUser() {
    try { return os.userInfo().username; } catch { return 'unknown'; }
  }

  // Notes writes are knowledge-base edits, not device changes: keep them out of the
  // device's MeshCentral Events tab and keep note bodies out of the audit summary.
  const notDeviceChange = () => false;

  async function call(op, args = {}, timeoutMs = 10_000) {
    let res;
    try {
      res = await client.sendCommand({ action: 'plugin', plugin: 'mcpnotes', op, via, ...args }, timeoutMs);
    } catch (err) {
      if (/did not answer/.test(err.message)) {
        throw new Error('The mcpnotes plugin did not answer. Is it installed and enabled on the MeshCentral server ' +
          '(My Server → Plugins), with settings.plugins enabled in config.json?');
      }
      throw err;
    }
    if (res?.plugin !== 'mcpnotes') throw new Error('Unexpected reply from MeshCentral (not from the mcpnotes plugin); try again.');
    if (!res.ok) {
      const e = new Error(res.error || 'mcpnotes request failed');
      e.currentRev = res.result?.currentRev;
      throw e;
    }
    return res.result;
  }

  const fmtSummary = (n) =>
    `${n.path}  rev ${n.rev}  ${String(n.updated || '').slice(0, 16).replace('T', ' ')} by ${n.updatedBy}` +
    `${n.nodeid ? `  [device ${n.nodeid}]` : ''}  ${n.size} B`;

  const fmtNote = (n) =>
    `--- ${n.path} (rev ${n.rev}, updated ${String(n.updated || '').slice(0, 16).replace('T', ' ')} by ${n.updatedBy}` +
    `${n.nodeid ? `, device ${n.nodeid}` : ''}) ---\n${sanitizeText(n.body)}`;

  const pathArg = z.string().describe('Note path, e.g. "ACME/servers.md", "ACME/devices/mail.acme.example.md", "ACME/users/jdoe.md"');

  // ════════════════════════════════════════════════════════════════════════
  // R — read notes
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_notes_for_device', tier: 'R', title: 'Notes for a device',
    description:
      'Everything the team has written down about a device, from the server-side notes: its device note, other ' +
      'notes that mention it, and its client index (servers.md). Read this before working on a device, together ' +
      'with mesh_device_history.',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) => {
      const nodeid = await resolveNodeId(node_id);
      const r = await call('fornode', { nodeid });
      const parts = [...r.device, ...r.index, ...r.mentions];
      if (!parts.length) {
        return textResult(`No notes about ${nodeid} yet. Start one with mesh_notes_append ` +
          '(path "<Client>/devices/<device-name>.md", node_id set) — device name, node ID, OS, role/IP, then a dated "## Log".');
      }
      const head = `Device note: ${r.device.length ? r.device.map((n) => n.path).join(', ') : 'none yet'}` +
        `${r.clients.length ? ` | client: ${r.clients.join(', ')}` : ''}`;
      const logons = r.logons.length
        ? 'Logons seen (MeshCentral):\n' + r.logons.map((l) => `  ${sanitizeText(l.name)}${l.now ? ' (logged on now)' : ''}` +
          `${l.last ? `, last ${String(l.last).slice(0, 10)}` : ''} → ${l.user || 'no user note'}`).join('\n')
        : null;
      return textResult([head, logons, ...parts.map(fmtNote)].filter(Boolean).join('\n\n'));
    },
  });

  define({
    name: 'mesh_notes_client', tier: 'R', title: 'Client overview',
    description:
      'A client (company) as it is right now: its device groups and devices built live from MeshCentral (online, ' +
      'OS, who logs on, which device/user note covers each), its servers.md notes, its user notes, and gaps to fix ' +
      '(devices without a note, notes for removed devices, unlinked device notes). The device list is never stored, ' +
      'so keep servers.md to what MeshCentral cannot know: contacts, sites/network, client-wide decisions, log, open actions.',
    schema: { client: z.string().describe('Client folder name, e.g. "ACME"') },
    handler: async ({ client: c }) => {
      const r = await call('client', { client: c }, 20_000);
      const lines = [`Client ${r.client}${r.mapped ? '' : ' (folder not mapped to any device group yet: mesh_notes_map_client)'}`];
      if (r.groups.length) lines.push(`Groups: ${r.groups.map((g) => g.name).join(', ')}`);
      if (r.devices.length) {
        lines.push(`\nDevices (${r.devices.length}, live):`);
        for (const d of r.devices) {
          const who = d.logons.slice(0, 3).map((l) => `${sanitizeText(l.name)}${l.user ? '' : '?'}`).join(', ');
          lines.push(`  ${d.online ? '●' : '○'} ${d.name}  ${d.group}  ${d.os || ''}  ${d.note ? `note: ${d.note}` : 'NO NOTE'}${who ? `  users: ${who}` : ''}`);
        }
        lines.push('  (● online ○ offline; "?" = logon with no user note)');
      }
      if (r.users.length) lines.push(`\nUser notes: ${r.users.map((u) => `${u.path}${u.email ? ` <${u.email}>` : ''}`).join(', ')}`);
      if (r.notes.length) lines.push(`Other notes: ${r.notes.map((n) => n.path).join(', ')}`);
      const issues = Object.entries(r.issues).filter(([, v]) => v.length);
      if (issues.length) {
        const label = {
          devicesWithoutNote: 'Devices without a note', notesForRemovedDevices: 'Notes for devices no longer in MeshCentral',
          notesForDevicesOutsideClient: "Notes for devices now outside this client's groups", deviceNotesNotLinked: 'Device notes not linked to a device (set node_id)',
        };
        lines.push('\nTo fix:', ...issues.map(([k, v]) => `  ${label[k]}: ${v.join(', ')}`));
      }
      if (r.index) lines.push('', fmtNote(r.index));
      return textResult(lines.join('\n'));
    },
  });

  define({
    name: 'mesh_notes_for_user', tier: 'R', title: 'Notes and devices for a user',
    description:
      "A user note plus where MeshCentral has actually seen that person log on, compared with the devices the note " +
      'lists. Users are matched by email, aliases and AD account in the note, not by file name.',
    schema: { path: pathArg },
    handler: async ({ path }) => {
      const [u, n] = await Promise.all([call('foruser', { path }, 20_000), call('get', { path })]);
      const lines = [
        `Matched by: ${u.matchedBy.join(', ') || '(nothing: add email:/aliases: frontmatter)'}${u.email ? ` | email ${u.email}` : ''}`,
        u.seenOn.length
          ? 'Seen on (MeshCentral):\n' + u.seenOn.map((s) => `  ${s.name} as ${sanitizeText(s.logon)}${s.now ? ' (logged on now)' : ''}` +
            `${s.last ? `, last ${String(s.last).slice(0, 10)}` : ''}`).join('\n')
          : 'Not seen logging on to any device of this client yet.',
        `Listed in the note: ${u.listed.map((l) => l.name).join(', ') || 'none'}`,
      ];
      if (u.seenNotListed.length) lines.push(`Seen but not in the note: ${u.seenNotListed.join(', ')}`);
      if (u.listedNotSeen.length) lines.push(`In the note but not seen: ${u.listedNotSeen.join(', ')} (no logon recorded since the plugin was installed)`);
      return textResult(`${lines.join('\n')}\n\n${fmtNote(n.note)}`);
    },
  });

  define({
    name: 'mesh_notes_list', tier: 'R', title: 'List notes',
    description: 'List server-side notes you can read, optionally under a folder ("ACME/", "ACME/devices/") or of one kind.',
    schema: {
      prefix: z.string().optional().describe('Folder prefix, e.g. "ACME" or "ACME/devices"'),
      kind: z.enum(['index', 'device', 'user', 'note']).optional().describe('index = <Client>/servers.md'),
    },
    handler: async ({ prefix, kind }) => {
      const r = await call('list', { prefix, kind });
      return textResult(r.notes.length ? r.notes.map(fmtSummary).join('\n') : 'No notes found.');
    },
  });

  define({
    name: 'mesh_notes_read', tier: 'R', title: 'Read a note',
    description: 'Read one server-side note (optionally an earlier revision from mesh_notes_history).',
    schema: { path: pathArg, rev: z.number().int().positive().optional().describe('Earlier revision number') },
    handler: async ({ path, rev }) => {
      const r = await call('get', { path, rev });
      return textResult(`${fmtNote(r.note)}\n\n(To replace it, pass base_rev ${r.note.rev} to mesh_notes_write.)`);
    },
  });

  define({
    name: 'mesh_notes_search', tier: 'R', title: 'Search notes',
    description: 'Search server-side notes (every word must appear). Returns matching lines per note, best first.',
    schema: {
      query: z.string().describe('Words to find, e.g. "certificate renewal"'),
      prefix: z.string().optional().describe('Limit to a folder, e.g. "GLOBEX"'),
      limit: z.number().int().positive().max(100).optional(),
    },
    handler: async ({ query, prefix, limit }) => {
      const r = await call('search', { query, prefix, limit });
      if (!r.results.length) return textResult('No matches.');
      return textResult(r.results.map((x) =>
        `${x.path} (rev ${x.rev})\n${x.hits.map((h) => `  ${h.line}: ${sanitizeText(h.text)}`).join('\n')}`).join('\n\n'));
    },
  });

  define({
    name: 'mesh_notes_history', tier: 'R', title: 'Note history',
    description: 'Revisions of a note (the server keeps the last 25), newest first, with who changed it.',
    schema: { path: pathArg },
    handler: async ({ path }) => {
      const r = await call('history', { path });
      return textResult(r.revisions.map((n) => `${fmtSummary(n)}${n.message ? `  — ${sanitizeText(n.message)}` : ''}`).join('\n'));
    },
  });

  // ════════════════════════════════════════════════════════════════════════
  // W — write notes (reversible: every change keeps the previous revision)
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_notes_append', tier: 'W', title: 'Append to a note', change: notDeviceChange,
    description:
      'Add a dated entry under a heading of a server-side note (default "## Log"), creating the note if needed. ' +
      'Safe with other technicians editing at the same time. Use it at the end of a session for what was found, ' +
      'changed and left open. Never record passwords, tokens or other secrets. New user notes: name them ' +
      '<Client>/users/<email>.md and start with frontmatter "---\\nemail: …\\naliases: DOMAIN\\\\user, Display Name\\n---" ' +
      'so logons match them; link the devices they use as [name](../devices/<device>.md).',
    schema: {
      path: pathArg,
      text: z.string().describe('Markdown to add, e.g. "- 2026-10-30 — disk 92% on C:, cleared WinSxS; open: …"'),
      heading: z.string().optional().describe('Section heading, default "## Log" (e.g. "## Open")'),
      node_id: z.string().optional().describe('Link a new device note to this device (node ID or name)'),
    },
    describe: async ({ path, heading }) => `Append to note ${path} (${heading || '## Log'})`,
    handler: async ({ path, text, heading, node_id }) => {
      const nodeid = node_id ? await resolveNodeId(node_id) : undefined;
      const r = await call('append', { path, text, heading, nodeid });
      return textResult(`${r.created ? 'Created' : 'Updated'} ${r.note.path} (rev ${r.note.rev}).`);
    },
  });

  define({
    name: 'mesh_notes_write', tier: 'W', title: 'Write a note', change: notDeviceChange,
    description:
      'Replace the whole body of a server-side note (to restructure it or update facts such as versions). ' +
      'base_rev must be the revision you read (0 to create a new note); if someone changed it since, the call ' +
      'fails — read it again and re-apply. Prefer mesh_notes_append for log entries. Never record secrets.',
    schema: {
      path: pathArg,
      body: z.string().describe('Full Markdown body'),
      base_rev: z.number().int().min(0).describe('Revision the edit is based on; 0 to create'),
      node_id: z.string().optional().describe('Device this note is about (node ID or name); "" to unlink'),
      message: z.string().optional().describe('Short change summary for the history'),
    },
    describe: async ({ path, base_rev, message }) => `Write note ${path} (base rev ${base_rev})${message ? `: ${message}` : ''}`,
    handler: async ({ path, body, base_rev, node_id, message }) => {
      const nodeid = node_id === '' ? null : node_id ? await resolveNodeId(node_id) : undefined;
      try {
        const r = await call('put', { path, body, baseRev: base_rev, nodeid, message });
        return textResult(`${r.created ? 'Created' : 'Saved'} ${r.note.path} (rev ${r.note.rev}).`);
      } catch (err) {
        if (err.currentRev != null) return errorResult(`${err.message}`);
        throw err;
      }
    },
  });

  // ════════════════════════════════════════════════════════════════════════
  // A — note administration
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_notes_delete', tier: 'A', title: 'Delete a note', change: notDeviceChange,
    description: 'Delete a server-side note (needs the plugin\'s "Manage notes" right). The last revision is kept in history.',
    schema: { path: pathArg, base_rev: z.number().int().positive().describe('Current revision (from mesh_notes_read)') },
    confirmSummary: async ({ path, base_rev }) => `Delete note ${path} (rev ${base_rev})`,
    handler: async ({ path, base_rev }) => {
      const r = await call('delete', { path, baseRev: base_rev });
      return textResult(`Deleted ${r.deleted} (last rev ${r.lastRev} kept in history).`);
    },
  });

  define({
    name: 'mesh_notes_merge', tier: 'A', title: 'Merge or rename a note', change: notDeviceChange,
    description:
      'Fold one note into another in the same client folder — e.g. two user notes for the same person — keeping the ' +
      "source's aliases and history; or move it when the target does not exist (e.g. rename users/jsmith.md to " +
      'users/<email>.md). The source is removed, its last revision kept in history.',
    schema: { from: pathArg, into: pathArg },
    confirmSummary: async ({ from, into }) => `Merge note ${from} into ${into}`,
    handler: async ({ from, into }) => {
      const r = await call('merge', { from, into });
      return textResult(`${r.moved ? 'Moved' : 'Merged'} ${r.removed} → ${r.note.path} (rev ${r.note.rev}).`);
    },
  });

  define({
    name: 'mesh_notes_map_client', tier: 'A', title: 'Map a client folder to device groups', change: notDeviceChange,
    description:
      'Say which device groups a client folder belongs to (e.g. "ACME" → the ACME groups). Users with rights on any ' +
      'of those groups can then read and write that folder\'s notes. Replaces the previous mapping. Call with no ' +
      'groups to list current mappings.',
    schema: {
      client: z.string().optional().describe('Client folder name, e.g. "ACME"'),
      group_ids: z.array(z.string()).optional().describe('Device group IDs (mesh/...) or bare group IDs'),
    },
    confirmSummary: async ({ client: c, group_ids }) => `Map notes folder ${c} to groups ${(group_ids || []).join(', ')}`,
    handler: async ({ client: c, group_ids }) => {
      if (!c || !group_ids) {
        const r = await call('clients');
        return textResult(r.clients.length ? r.clients.map((x) => `${x.client}: ${(x.meshids || ['(groups hidden)']).join(', ')}`).join('\n') : 'No client folders mapped yet.');
      }
      const r = await call('setclient', { client: c, meshids: group_ids.map(meshId) });
      return textResult(`${r.client} → ${r.meshids.join(', ') || '(no groups: admin-only)'}`);
    },
  });
}
