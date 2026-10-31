import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

import { registerTools } from '../src/register.js';
import { Policy, ConfirmationGate } from '../src/safety.js';
import { AuditLog } from '../src/audit.js';

// End to end: the mesh_notes_* tools talk to the real mcpnotes plugin through a
// fake control websocket backed by an in-memory MeshCentral database.
const require = createRequire(import.meta.url);
const { mcpnotes } = require('../plugin/mcpnotes/mcpnotes.js');

const NODES = [{ _id: 'node//MailNodeAAAAAAAAAAAAAAAAAAAAAAAA', name: 'mail.acme.example', meshid: 'mesh//acme', conn: 1, agent: { id: 6 } }];
const ADMIN = { _id: 'user//admin', name: 'admin', siteadmin: 0xFFFFFFFF };

function setup({ installed = true } = {}) {
  const store = new Map();
  for (const n of NODES) store.set(n._id, { type: 'node', domain: '', users: ['ACME\\jsmith'], ...n });
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const db = {
    Get: (id, cb) => setImmediate(() => cb(null, store.has(id) ? [clone(store.get(id))] : [])),
    Set: (doc, cb) => setImmediate(() => { store.set(doc._id, clone(doc)); cb(null); }),
    Remove: (id, cb) => setImmediate(() => { store.delete(id); cb(null); }),
    GetAllTypeNoTypeField: (type, domain, cb) => setImmediate(() => cb(null, [...store.values()]
      .filter((d) => d.type === type && d.domain === domain).map((d) => { const c = clone(d); delete c.type; return c; }))),
  };
  const webserver = {
    GetMeshRights: () => 0xFFFF,
    GetNodeWithRights: (domain, user, nodeid, cb) => setImmediate(() => cb({ _id: nodeid }, 0xFFFF, NODES.some((n) => n._id === nodeid))),
  };
  const plugin = mcpnotes({ parent: { db, webserver } });

  const client = {
    domain: '', sent: [], raw: [],
    async sendCommand(cmd, timeoutMs) {
      this.sent.push(cmd);
      if (cmd.action === 'nodes') return { action: 'nodes', nodes: { 'mesh//acme': NODES } };
      if (cmd.action === 'plugin') {
        if (!installed) throw new Error(`MeshCentral did not answer 'plugin' within ${timeoutMs / 1000}s`);
        return new Promise((resolve) => plugin.serveraction({ ...cmd, responseid: 'x' },
          { user: ADMIN, domain: { id: '' }, ws: { send: (s) => resolve(JSON.parse(s)) } }));
      }
      return { action: cmd.action };
    },
    async sendRaw(cmd) { this.raw.push(cmd); },
    on() { return () => {}; },
  };
  const server = { tools: {}, registerTool(name, meta, cb) { this.tools[name] = { meta, cb }; }, getClientCapabilities: () => ({}) };
  const { terminals, desktops } = registerTools({
    server, client, audit: new AuditLog({ client, deviceEvents: 'changes' }),
    config: { terminalIdleMinutes: 15, terminalMaxSessions: 5, desktopIdleMinutes: 10, desktopMaxSessions: 3, desktopIdleFrameMs: 0, commandTimeoutSeconds: 300, commandMaxTimeoutSeconds: 3600 },
    policy: new Policy({ profile: 'support' }), gate: new ConfirmationGate({ mode: 'off' }),
  });
  const call = async (name, args = {}) => {
    const r = await server.tools[name].cb(args, {});
    return { text: r.content[0].text, isError: Boolean(r.isError) };
  };
  return { client, server, store, call, cleanup: () => { terminals.closeAll(); desktops.closeAll(); } };
}

test('notes tools: append, read, write with revision check, search, for-device', async () => {
  const { client, call, cleanup } = setup();

  const empty = await call('mesh_notes_for_device', { node_id: 'mail.acme.example' });
  assert.match(empty.text, /No notes about node\/\/MailNode/);

  const a = await call('mesh_notes_append', { path: 'ACME/devices/mail.acme.example.md', node_id: 'mail.acme.example', text: '- 2026-10-30 postfix updated' });
  assert.equal(a.isError, false, a.text);
  assert.match(a.text, /Created ACME\/devices\/mail.acme.example.md \(rev 1\)/);

  const r = await call('mesh_notes_read', { path: 'ACME/devices/mail.acme.example.md' });
  assert.match(r.text, /## Log\n\n- 2026-10-30 postfix updated/);
  assert.match(r.text, /base_rev 1/);

  const stale = await call('mesh_notes_write', { path: 'ACME/devices/mail.acme.example.md', body: '# x', base_rev: 0 });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /conflict: .* is at rev 1/);

  const w = await call('mesh_notes_write', { path: 'ACME/devices/mail.acme.example.md', body: '# mail\n\npostfix 2026-10\n', base_rev: 1, message: 'rewrite' });
  assert.match(w.text, /Saved .* \(rev 2\)/);

  const s = await call('mesh_notes_search', { query: 'POSTFIX' });
  assert.match(s.text, /ACME\/devices\/mail.acme.example.md \(rev 2\)\n  3: postfix 2026-10/);

  const d = await call('mesh_notes_for_device', { node_id: 'mail.acme.example' });
  assert.match(d.text, /^Device note: ACME\/devices\/mail.acme.example.md/);

  const h = await call('mesh_notes_history', { path: 'ACME/devices/mail.acme.example.md' });
  assert.match(h.text, /rev 2 .* — rewrite\n.*rev 1/);

  // Notes stay out of the web UI: no device events for notes writes.
  assert.equal(client.raw.filter((c) => c.action === 'setDeviceEvent').length, 0);
  assert.ok(client.sent.filter((c) => c.action === 'plugin').every((c) => /^meshcentral-mcp \(/.test(c.via)));
  cleanup();
});

test('notes tools explain a missing plugin', async () => {
  const { call, cleanup } = setup({ installed: false });
  const r = await call('mesh_notes_list');
  assert.equal(r.isError, true);
  assert.match(r.text, /mcpnotes plugin did not answer/);
  cleanup();
});

test('admin-only notes tools are not registered below the admin profile', () => {
  const { server, cleanup } = setup();
  assert.ok(server.tools.mesh_notes_append);
  assert.equal(server.tools.mesh_notes_delete, undefined);
  assert.equal(server.tools.mesh_notes_map_client, undefined);
  assert.equal(server.tools.mesh_notes_merge, undefined);
  cleanup();
});

test('mesh_notes_client shows the live device list and gaps; mesh_notes_for_user compares logons', async () => {
  const { client, call, cleanup } = setup();
  await client.sendCommand({ action: 'plugin', plugin: 'mcpnotes', op: 'setclient', client: 'ACME', meshids: ['mesh//acme'] });
  await call('mesh_notes_append', { path: 'ACME/servers.md', text: '- contacts: office manager', heading: '## Contacts' });
  await call('mesh_notes_append', { path: 'ACME/users/jsmith.md', text: '- printer issue' });
  await call('mesh_notes_append', { path: 'ACME/devices/retired.md', text: '- old box' });

  const c = await call('mesh_notes_client', { client: 'ACME' });
  assert.equal(c.isError, false, c.text);
  assert.match(c.text, /^Client ACME\n/);
  assert.match(c.text, /○ mail\.acme\.example .* NO NOTE  users: ACME\\jsmith\n/, 'offline: no connected agent in this fake');
  assert.match(c.text, /User notes: ACME\/users\/jsmith\.md/);
  assert.match(c.text, /Devices without a note: mail\.acme\.example/);
  assert.match(c.text, /Device notes not linked to a device \(set node_id\): ACME\/devices\/retired\.md/);
  assert.match(c.text, /## Contacts\n\n- contacts: office manager/);

  const u = await call('mesh_notes_for_user', { path: 'ACME/users/jsmith.md' });
  assert.match(u.text, /^Matched by: jsmith/);
  assert.match(u.text, /Seen on \(MeshCentral\):\n  mail\.acme\.example as ACME\\jsmith \(logged on now\)/);
  assert.match(u.text, /Seen but not in the note: mail\.acme\.example/);

  const d = await call('mesh_notes_for_device', { node_id: 'mail.acme.example' });
  assert.match(d.text, /client: ACME/);
  assert.match(d.text, /ACME\\jsmith \(logged on now\) → ACME\/users\/jsmith\.md/);
  cleanup();
});
