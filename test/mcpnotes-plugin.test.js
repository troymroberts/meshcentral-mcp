import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

// The MeshCentral plugin is CommonJS (plugin/mcpnotes/package.json); drive its
// serveraction against an in-memory stand-in for MeshCentral's db and webserver.
const require = createRequire(import.meta.url);
const lib = require('../plugin/mcpnotes/lib/notes.js');
const { mcpnotes } = require('../plugin/mcpnotes/mcpnotes.js');

const ACME_MESH = 'mesh//acmegroup';
const GLOBEX_MESH = 'mesh//globexgroup';
const MAIL_NODE = 'node//MailNodeAAAAAAAAAAAAAAAAAAAAAAAA';
const CAM_NODE = 'node//CameraNodeBBBBBBBBBBBBBBBBBBBBBB';
const TERM_NODE = 'node//TermNodeCCCCCCCCCCCCCCCCCCCCCCCCCC';

function fakeServer({ permissionsApi = true } = {}) {
  const store = new Map();
  // Device records as MeshCentral keeps them (users = who is logged on now).
  for (const n of [
    { _id: MAIL_NODE, name: 'mail.acme.example', meshid: ACME_MESH, osdesc: 'Debian 12' },
    { _id: TERM_NODE, name: 'ACME-TS', meshid: ACME_MESH, osdesc: 'Windows Server 2019', users: ['ACME\\jsmith'] },
    { _id: CAM_NODE, name: 'camera', meshid: GLOBEX_MESH },
  ]) store.set(n._id, { type: 'node', domain: '', ...n });
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const db = {
    Get: (id, cb) => setImmediate(() => cb(null, store.has(id) ? [clone(store.get(id))] : [])),
    Set: (doc, cb) => setImmediate(() => { store.set(doc._id, clone(doc)); cb(null); }),
    Remove: (id, cb) => setImmediate(() => { store.delete(id); cb(null); }),
    GetAllTypeNoTypeField: (type, domain, cb) => setImmediate(() => cb(null, [...store.values()]
      .filter((d) => d.type === type && d.domain === domain).map((d) => { const c = clone(d); delete c.type; return c; }))),
  };
  const nodes = { [MAIL_NODE]: ACME_MESH, [TERM_NODE]: ACME_MESH, [CAM_NODE]: GLOBEX_MESH };
  const webserver = {
    meshes: { [ACME_MESH]: { name: 'ACME Servers' }, [GLOBEX_MESH]: { name: 'GLOBEX' } },
    wsagents: { [TERM_NODE]: {} },
    GetMeshRights: (user, meshid) => (user.siteadmin === 0xFFFFFFFF || (user.meshes || []).includes(meshid) ? 0xFFFF : 0),
    GetNodeWithRights: (domain, user, nodeid, cb) => setImmediate(() => {
      const ok = nodes[nodeid] && (user.siteadmin === 0xFFFFFFFF || (user.nodes || []).includes(nodeid) || (user.meshes || []).includes(nodes[nodeid]));
      cb(ok ? { _id: nodeid } : null, ok ? 0xFFFF : 0, Boolean(ok));
    }),
  };
  // MeshCentral's plugin-permission API: users here carry the permissions granted to them.
  const handler = { parent: { db, webserver } };
  if (permissionsApi) {
    handler.registerPermissions = () => {};
    handler.getAccessPermissions = async (name, user) => (p) => (p === '_ALL_' ? user.perms || [] : (user.perms || []).includes(p));
  }
  const plugin = mcpnotes(handler);
  let seq = 0;
  const call = (user, op, args = {}) => new Promise((resolve) => {
    const responseid = `r${++seq}`;
    const session = { user, domain: { id: '' }, ws: { send: (s) => resolve(JSON.parse(s)) } };
    plugin.serveraction({ action: 'plugin', plugin: 'mcpnotes', op, responseid, ...args }, session);
  });
  // Wait for the plugin's serialised writes (the agent hook does not reply).
  const settle = () => call({ siteadmin: 0xFFFFFFFF, name: 'probe' }, 'append', { path: 'zz/settle.md', text: '-' });
  return { store, call, plugin, settle };
}

const admin = { _id: 'user//admin', name: 'admin', siteadmin: 0xFFFFFFFF };
const acmeTech = { _id: 'user//acmetech', name: 'acmetech', siteadmin: 0, meshes: [ACME_MESH], perms: ['can_read', 'can_write'] };
const camOnly = { _id: 'user//camonly', name: 'camonly', siteadmin: 0, nodes: [CAM_NODE], perms: ['can_read', 'can_write'] };
// Client staff: full rights on their own group, no notes permissions.
const acmeStaff = { _id: 'user//staff', name: 'staff', siteadmin: 0, meshes: [ACME_MESH], nodes: [TERM_NODE] };
const acmeReader = { _id: 'user//reader', name: 'reader', siteadmin: 0, meshes: [ACME_MESH], perms: ['can_read'] };

async function seed(call) {
  await call(admin, 'setclient', { client: 'ACME', meshids: [ACME_MESH] });
  await call(admin, 'setclient', { client: 'GLOBEX', meshids: [GLOBEX_MESH] });
  await call(admin, 'put', { path: 'ACME/servers.md', baseRev: 0, body: `# ACME\n\n| mail | \`${MAIL_NODE}\` |\n` });
  await call(admin, 'put', { path: 'ACME/devices/mail.acme.example.md', baseRev: 0, nodeid: MAIL_NODE, body: `# mail\n\n- **Node ID:** \`${MAIL_NODE}\`\n\n## Log\n\n- 2026-10-01 created\n\n## Open\n\n- none\n` });
  await call(admin, 'put', { path: 'GLOBEX/devices/camera.md', baseRev: 0, nodeid: CAM_NODE, body: '# camera\n' });
  await call(admin, 'put', { path: 'security/incident.md', baseRev: 0, body: '# incident\npostfix\n' });
}

test('replies echo responseid and report unknown ops', async () => {
  const { call } = fakeServer();
  const r = await call(admin, 'nope');
  assert.equal(r.responseid, 'r1');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown op/);
});

test('put creates, then enforces baseRev and returns currentRev on conflict', async () => {
  const { call } = fakeServer();
  const a = await call(admin, 'put', { path: 'ACME/servers.md', baseRev: 0, body: '# ACME\n' });
  assert.equal(a.ok, true);
  assert.equal(a.result.created, true);
  assert.equal(a.result.note.rev, 1);
  const stale = await call(admin, 'put', { path: 'ACME/servers.md', baseRev: 0, body: '# other\n' });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /conflict/);
  assert.equal(stale.result.currentRev, 1);
  const b = await call(admin, 'put', { path: 'acme/SERVERS.md', baseRev: 1, body: '# ACME v2\n' });
  assert.equal(b.ok, true, b.error);
  assert.equal(b.result.note.rev, 2);
  assert.equal(b.result.note.path, 'ACME/servers.md', 'original casing is kept');
});

test('append adds under the heading, creating note and section when missing', async () => {
  const { call } = fakeServer();
  await seed(call);
  const r = await call(admin, 'append', { path: 'ACME/devices/mail.acme.example.md', text: '- 2026-10-30 disk ok' });
  assert.equal(r.ok, true, r.error);
  const g = await call(admin, 'get', { path: 'ACME/devices/mail.acme.example.md' });
  assert.match(g.result.note.body, /- 2026-10-01 created\n- 2026-10-30 disk ok\n\n## Open/);
  const n = await call(admin, 'append', { path: 'ACME/users/jdoe.md', text: '- new user' });
  assert.equal(n.result.created, true);
  const u = await call(admin, 'get', { path: 'ACME/users/jdoe.md' });
  assert.equal(u.result.note.body, '# jdoe\n\n## Log\n\n- new user\n');
});

test('group rights scope reads to the mapped client folder', async () => {
  const { call } = fakeServer();
  await seed(call);
  const list = await call(acmeTech, 'list');
  assert.deepEqual(list.result.notes.map((n) => n.path), ['ACME/devices/mail.acme.example.md', 'ACME/servers.md']);
  const globex = await call(acmeTech, 'get', { path: 'GLOBEX/devices/camera.md' });
  assert.equal(globex.ok, false);
  assert.match(globex.error, /not found/, 'no-access looks the same as missing');
  const sec = await call(acmeTech, 'search', { query: 'postfix' });
  assert.deepEqual(sec.result.results, [], 'top-level notes are not visible to group users');
  const w = await call(acmeTech, 'put', { path: 'GLOBEX/devices/new.md', baseRev: 0, body: 'x' });
  assert.equal(w.ok, false);
  const ok = await call(acmeTech, 'append', { path: 'ACME/devices/mail.acme.example.md', text: '- tech note', via: 'claude-code' });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.result.note.updatedBy, 'acmetech');
});

test('device rights alone reach the notes linked to that device', async () => {
  const { call } = fakeServer();
  await seed(call);
  const list = await call(camOnly, 'list');
  assert.deepEqual(list.result.notes.map((n) => n.path), ['GLOBEX/devices/camera.md']);
  const link = await call(camOnly, 'put', { path: 'GLOBEX/devices/camera.md', baseRev: 1, body: '# camera\n', nodeid: MAIL_NODE });
  assert.equal(link.ok, false, 'cannot link a note to a device the user cannot see');
});

test('fornode returns the device note, mentions and the client index', async () => {
  const { call } = fakeServer();
  await seed(call);
  const r = await call(acmeTech, 'fornode', { nodeid: MAIL_NODE });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.result.device.map((n) => n.path), ['ACME/devices/mail.acme.example.md']);
  assert.deepEqual(r.result.index.map((n) => n.path), ['ACME/servers.md']);
  assert.deepEqual(r.result.mentions, [], 'the client index is not repeated as a mention');
  const denied = await call(camOnly, 'fornode', { nodeid: MAIL_NODE });
  assert.equal(denied.ok, false);
});

test('history keeps earlier revisions; delete needs manage and is undoable', async () => {
  const { call } = fakeServer();
  await seed(call);
  for (let i = 0; i < 3; i++) await call(admin, 'append', { path: 'ACME/servers.md', text: `- entry ${i}` });
  const h = await call(admin, 'history', { path: 'ACME/servers.md' });
  assert.deepEqual(h.result.revisions.map((r) => r.rev), [4, 3, 2, 1]);
  const old = await call(admin, 'get', { path: 'ACME/servers.md', rev: 1 });
  assert.doesNotMatch(old.result.note.body, /entry/);
  const no = await call(acmeTech, 'delete', { path: 'ACME/servers.md', baseRev: 4 });
  assert.equal(no.ok, false);
  const del = await call(admin, 'delete', { path: 'ACME/servers.md', baseRev: 4 });
  assert.equal(del.ok, true, del.error);
  assert.equal((await call(admin, 'get', { path: 'ACME/servers.md' })).ok, false);
});

test('history is capped', async () => {
  const { store, call } = fakeServer();
  await call(admin, 'put', { path: 'x/a.md', baseRev: 0, body: 'a' });
  for (let i = 0; i < lib.HISTORY_KEEP + 5; i++) await call(admin, 'append', { path: 'x/a.md', text: `- ${i}` });
  const hist = [...store.keys()].filter((k) => k.startsWith('mcpnotehist/'));
  assert.equal(hist.length, lib.HISTORY_KEEP - 1);
});

test('path rules reject traversal and non-markdown', () => {
  for (const bad of ['../etc/passwd.md', 'ACME/../x.md', 'ACME/x.txt', '.hidden/x.md', 'a/b/c/d/e.md', '']) {
    assert.throws(() => lib.normalizePath(bad), undefined, bad);
  }
  assert.equal(lib.normalizePath('\\ACME\\devices\\mail.md'), 'ACME/devices/mail.md');
  assert.equal(lib.normalizePath('Initech/devices/Test Server DEV.md'), 'Initech/devices/Test Server DEV.md');
});

test('appendToSection keeps following sections and handles empty notes', () => {
  assert.equal(lib.appendToSection('', '## Log', '- a'), '## Log\n\n- a\n');
  assert.equal(lib.appendToSection('# T\n\n## Log\n\n- a\n\n## Open\n- b\n', 'Log', '- c'), '# T\n\n## Log\n\n- a\n- c\n\n## Open\n- b\n');
  assert.equal(lib.appendToSection('# T\n\n## Log\n### 2026-10-01\n- a\n', '## Log', '- c'), '# T\n\n## Log\n### 2026-10-01\n- a\n- c\n');
});

test('extractNodeIds finds node IDs in markdown', () => {
  assert.deepEqual(lib.extractNodeIds(`- **Node ID:** \`${MAIL_NODE}\` and ${MAIL_NODE} and node//Zx9Qa1b2c3d4e5@f6g7h8i9j0kLmNoPqRsTuVwXyZ0123456789AbCdEfGhIjKlM`),
    [MAIL_NODE, 'node//Zx9Qa1b2c3d4e5@f6g7h8i9j0kLmNoPqRsTuVwXyZ0123456789AbCdEfGhIjKlM']);
});

// ── company and user data ───────────────────────────────────────────────

const JSMITH = '# jsmith (ACME)\n\n- AD account: `jsmith` (Jane Smith)\n- Devices used: [ACME-TS](../devices/ACME-TS.md)\n\n## Log\n- 2026-10-20 print issue\n';

test('client: live device list from the mapped groups, joined with notes and flagged gaps', async () => {
  const { call } = fakeServer();
  await seed(call);
  await call(admin, 'put', { path: 'ACME/devices/old-server.md', baseRev: 0, body: '# old\n' });
  await call(admin, 'put', { path: 'ACME/users/jsmith.md', baseRev: 0, body: JSMITH });
  const r = await call(acmeTech, 'client', { client: 'acme' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.result.client, 'ACME');
  assert.deepEqual(r.result.groups, [{ meshid: ACME_MESH, name: 'ACME Servers' }]);
  assert.deepEqual(r.result.devices.map((d) => [d.name, d.online, d.note]), [
    ['ACME-TS', true, null],
    ['mail.acme.example', false, 'ACME/devices/mail.acme.example.md'],
  ]);
  assert.deepEqual(r.result.devices[0].logons, [{ name: 'ACME\\jsmith', last: null, now: true, user: 'ACME/users/jsmith.md' }]);
  assert.match(r.result.index.body, /^# ACME/);
  assert.deepEqual(r.result.users.map((u) => u.path), ['ACME/users/jsmith.md']);
  assert.deepEqual(r.result.issues.devicesWithoutNote, ['ACME-TS']);
  assert.deepEqual(r.result.issues.deviceNotesNotLinked, ['ACME/devices/old-server.md']);
  const other = await call(acmeTech, 'client', { client: 'GLOBEX' });
  assert.equal(other.ok, false);
  assert.match(other.error, /client not found/);
});

test('the agent hook records logons; foruser compares seen-on with the devices the note lists', async () => {
  const { call, plugin, settle } = fakeServer();
  await seed(call);
  await call(admin, 'put', { path: 'ACME/devices/ACME-TS.md', baseRev: 0, nodeid: TERM_NODE, body: '# ACME-TS\n' });
  await call(admin, 'put', { path: 'ACME/users/jsmith.md', baseRev: 0, body: JSMITH });
  plugin.hook_processAgentData({ action: 'coreinfo', users: ['ACME\\jsmith'], upnusers: ['jsmith@acme.example'] },
    { dbNodeKey: MAIL_NODE, dbMeshKey: ACME_MESH, domain: { id: '' } });
  plugin.hook_processAgentData({ action: 'sysinfo' }, { dbNodeKey: MAIL_NODE });
  await settle();
  const r = await call(acmeTech, 'foruser', { path: 'ACME/users/jsmith.md' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([...new Set(r.result.seenOn.map((s) => s.name))].sort(), ['ACME-TS', 'mail.acme.example']);
  assert.ok(r.result.seenOn.find((s) => s.name === 'mail.acme.example').first, 'recorded logons carry first/last seen');
  assert.deepEqual(r.result.listed.map((l) => [l.name, l.via]), [['ACME-TS', 'ACME/devices/ACME-TS.md']]);
  assert.deepEqual(r.result.seenNotListed, ['mail.acme.example']);
  assert.deepEqual(r.result.listedNotSeen, []);
  const dev = await call(acmeTech, 'fornode', { nodeid: MAIL_NODE });
  assert.deepEqual(dev.result.logons.map((l) => [l.name, l.user]), [
    ['ACME\\jsmith', 'ACME/users/jsmith.md'], ['jsmith@acme.example', 'ACME/users/jsmith.md'],
  ]);
  assert.deepEqual(dev.result.clients, ['ACME']);
  assert.ok(dev.result.index.some((n) => n.path === 'ACME/servers.md'));
});

test('merge folds a duplicate user note in (aliases kept) or moves it to a new path', async () => {
  const { call } = fakeServer();
  await seed(call);
  await call(admin, 'put', { path: 'ACME/users/jsmith.md', baseRev: 0, body: JSMITH });
  const moved = await call(admin, 'merge', { from: 'ACME/users/jsmith.md', into: 'ACME/users/jane.smith@acme.example.md' });
  assert.equal(moved.ok, true, moved.error);
  assert.equal(moved.result.moved, true);
  await call(admin, 'put', { path: 'ACME/users/janes.md', baseRev: 0, body: '---\naliases: Jane S\n---\n# janes\n\n## Log\n- 2026-09-01 new laptop\n' });
  const merged = await call(admin, 'merge', { from: 'ACME/users/janes.md', into: 'ACME/users/jane.smith@acme.example.md' });
  assert.equal(merged.ok, true, merged.error);
  const g = await call(admin, 'get', { path: 'ACME/users/jane.smith@acme.example.md' });
  assert.match(g.result.note.body, /^---\naliases: Jane S, janes\n---\n# jsmith/);
  assert.match(g.result.note.body, /## Merged from ACME\/users\/janes.md \(\d{4}-\d\d-\d\d\)\n\n### janes\n\n#### Log\n- 2026-09-01 new laptop\n$/);
  assert.equal((await call(admin, 'get', { path: 'ACME/users/janes.md' })).ok, false);
  assert.match((await call(acmeTech, 'merge', { from: 'ACME/users/x.md', into: 'ACME/users/y.md' })).error, /Manage notes/);
  assert.match((await call(admin, 'merge', { from: 'ACME/users/jane.smith@acme.example.md', into: 'GLOBEX/users/a.md' })).error, /one client folder/);
});

test('userIdentities reads frontmatter and the cues existing notes carry', () => {
  const a = lib.userIdentities('ACME/users/jsmith.md', JSMITH);
  assert.deepEqual(a.names.sort(), ['jsmith']);
  const b = lib.userIdentities('GLOBEX/users/accounts.md', '# accounts@globex.example — Pat Lee\n\n- **Mailbox:** accounts@globex.example\n');
  assert.equal(b.email, 'accounts@globex.example');
  assert.deepEqual(b.names.sort(), ['accounts', 'accounts@globex.example']);
  const c = lib.userIdentities('ACME/users/x.md', '---\nemail: J.Doe@acme.com\naliases: ACME\\jdoe, "John Doe"\n---\n# x\n');
  assert.equal(c.email, 'j.doe@acme.com');
  assert.deepEqual(c.names.sort(), ['acme\\jdoe', 'j.doe', 'j.doe@acme.com', 'jdoe', 'john doe'], 'one-letter file names are not identities');
  assert.deepEqual(lib.logonForms('ACME\\JDoe'), ['acme\\jdoe', 'jdoe']);
});

test('linkedPaths resolves relative links; demoteHeadings nests merged text', () => {
  assert.deepEqual(lib.linkedPaths('ACME/users/jsmith.md', 'see [t](../devices/ACME-TS.md) and [x](https://a/b.md) and [s](../servers.md#log)'),
    ['acme/devices/acme-ts.md', 'acme/servers.md']);
  assert.equal(lib.demoteHeadings('# a\n## b\n###### c\nno #tag'), '### a\n#### b\n###### c\nno #tag');
  assert.equal(lib.setMeta('# t\n', { email: 'a@b.c', aliases: ['x'] }), '---\nemail: a@b.c\naliases: x\n---\n# t\n');
});

// ── permissions (0.2.0): group rights alone never reach notes ───────────

test('client staff with group and device rights but no notes permission get nothing', async () => {
  const { call, plugin, settle } = fakeServer();
  await seed(call);
  plugin.hook_processAgentData({ action: 'coreinfo', users: ['ACME\\jsmith'] }, { dbNodeKey: TERM_NODE, dbMeshKey: ACME_MESH, domain: { id: '' } });
  await settle();
  for (const [op, args] of [
    ['list', {}], ['get', { path: 'ACME/servers.md' }], ['search', { query: 'acme' }], ['fornode', { nodeid: TERM_NODE }],
    ['client', { client: 'ACME' }], ['history', { path: 'ACME/servers.md' }], ['clients', {}],
    ['append', { path: 'ACME/servers.md', text: '- x' }], ['put', { path: 'ACME/new.md', baseRev: 0, body: 'x' }],
  ]) {
    const r = await call(acmeStaff, op, args);
    assert.equal(r.ok, false, `${op} must be refused`);
    assert.match(r.error, /needs the "Read notes" permission/, op);
    assert.equal(r.result, null, `${op} returns no data`);
  }
  const who = await call(acmeStaff, 'whoami');
  assert.equal(who.ok, true);
  assert.deepEqual(who.result.permissions, []);
});

test('can_read without can_write reads but cannot change notes', async () => {
  const { call } = fakeServer();
  await seed(call);
  assert.equal((await call(acmeReader, 'get', { path: 'ACME/servers.md' })).ok, true);
  const w = await call(acmeReader, 'append', { path: 'ACME/servers.md', text: '- x' });
  assert.equal(w.ok, false);
  assert.match(w.error, /no write access/);
  assert.equal((await call(acmeReader, 'get', { path: 'GLOBEX/devices/camera.md' })).ok, false, 'can_read is still bounded by rights');
});

test('without the plugin-permissions API every default is denied: admins only', async () => {
  const { call } = fakeServer({ permissionsApi: false });
  await seed(call);
  const r = await call(acmeTech, 'list');
  assert.equal(r.ok, false);
  assert.match(r.error, /Read notes/);
  assert.equal((await call(admin, 'list')).result.notes.length, 4);
});
