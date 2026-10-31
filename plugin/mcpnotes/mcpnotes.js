'use strict';

// mcpnotes — server-side Markdown notes about clients, devices and users, kept in
// MeshCentral's own database and reached only through the control websocket
// ({ action: 'plugin', plugin: 'mcpnotes', op: ... }). It adds nothing to the web
// UI: no admin panel, no device tab, no exported browser code.
//
// Storage (main MeshCentral collection, works on NeDB/MongoDB/SQL backends):
//   mcpnote/<domain>/<lower-case path>          current note       type 'mcpnote'
//   mcpnotehist/<domain>/<lower-case path>@<rev> previous revisions type 'mcpnotehist'
//   mcpnotesclient/<domain>/<lower-case client>  client -> device groups map
//   mcpnotesseen/<domain>/<nodeid>               who has logged on to a device (first/last seen)
//
// Company data: a client is its folder plus the device groups mapped to it. Its device
// list is never stored — `client` builds it live from MeshCentral and joins the notes, so
// <Client>/servers.md only holds what MeshCentral cannot know (contacts, sites, log).
// User data: a user note is matched to logons by identity (email, aliases, AD account),
// not by file name. The agent hook records logons so "seen on" devices come from
// MeshCentral, and are compared with the devices the note itself lists.
//
// Access:
//   full site admin                    everything
//   can_read_all permission            every note (read)
//   rights on a device                 notes linked to that device (nodeid)
//   rights on any group of a client    every note in that client's folder
//   can_write permission               create/update notes the user can read
//   can_manage permission / site admin delete notes, map clients to groups

module.exports.mcpnotes = function mcpnotesPlugin(pluginHandler) {
    const lib = require('./lib/notes');
    const plugin = {};
    const root = pluginHandler.parent;
    const db = root.db;
    let writeQueue = Promise.resolve();

    const PERMISSIONS = {
        can_write: { title: 'Write notes', desc: 'Create and update notes for clients and devices the user can access.', default: 'allowed' },
        can_read_all: { title: 'Read all notes', desc: 'Read every note, including shared notes outside client folders.', default: 'denied' },
        can_manage: { title: 'Manage notes', desc: 'Delete notes and map client folders to device groups.', default: 'denied' },
    };
    let permissionsRegistered = false;
    function registerPermissions() {
        if (permissionsRegistered || typeof pluginHandler.registerPermissions !== 'function') return;
        pluginHandler.registerPermissions('mcpnotes', PERMISSIONS);
        permissionsRegistered = true;
    }
    registerPermissions();

    function log(message, error) {
        console.log(`[mcpnotes] ${message}${error ? `: ${error.stack || error.message || error}` : ''}`);
    }

    // ── database ─────────────────────────────────────────────────────────────
    const dbGet = (id) => new Promise((resolve, reject) => db.Get(id, (err, docs) => err ? reject(err) : resolve(Array.isArray(docs) && docs.length ? docs[0] : null)));
    const dbSet = (doc) => new Promise((resolve, reject) => db.Set(doc, (err) => err ? reject(err) : resolve(doc)));
    const dbRemove = (id) => new Promise((resolve, reject) => db.Remove(id, (err) => err ? reject(err) : resolve()));
    // GetAllTypeNoTypeField projects `type` out; put it back so a re-saved doc keeps it.
    const dbAll = (type, domain) => new Promise((resolve, reject) => db.GetAllTypeNoTypeField(type, domain, (err, docs) => err ? reject(err) : resolve((docs || []).map((d) => Object.assign(d, { type })))));

    const noteId = (domain, path) => `mcpnote/${domain}/${path.toLowerCase()}`;
    const histId = (domain, path, rev) => `mcpnotehist/${domain}/${path.toLowerCase()}@${rev}`;
    const clientId = (domain, client) => `mcpnotesclient/${domain}/${client.toLowerCase()}`;

    // Serialise writes so read-modify-write (append, rev checks) is atomic per server.
    function queued(fn) {
        const run = writeQueue.then(fn, fn);
        writeQueue = run.catch(() => {});
        return run;
    }

    // ── access ───────────────────────────────────────────────────────────────
    const isFullAdmin = (user) => Boolean(user && user.siteadmin === 0xFFFFFFFF);

    async function permissions(user) {
        if (isFullAdmin(user)) return () => true;
        if (typeof pluginHandler.getAccessPermissions === 'function') {
            return pluginHandler.getAccessPermissions('mcpnotes', user, {});
        }
        // MeshCentral without plugin permissions: fall back to the defaults.
        return (p) => Boolean(PERMISSIONS[p] && PERMISSIONS[p].default === 'allowed');
    }

    function nodeVisible(session, nodeid) {
        return new Promise((resolve) => {
            const web = root.webserver;
            if (!nodeid || !web || typeof web.GetNodeWithRights !== 'function') return resolve(false);
            web.GetNodeWithRights(session.domain, session.user, nodeid, (node, rights, visible) => resolve(Boolean(node && visible)));
        });
    }

    function meshAccessible(user, meshid) {
        const web = root.webserver;
        return Boolean(web && typeof web.GetMeshRights === 'function' && web.GetMeshRights(user, meshid) > 0);
    }

    // Per-request access helper: caches client maps and node checks for one call.
    async function accessFor(session) {
        const domain = session.domain.id;
        const user = session.user;
        const perm = await permissions(user);
        const admin = isFullAdmin(user);
        const readAll = admin || perm('can_read_all');
        const clientCache = new Map();
        const nodeCache = new Map();

        async function clientReadable(client) {
            if (!client) return false;
            if (!clientCache.has(client)) {
                const map = await dbGet(clientId(domain, client));
                clientCache.set(client, Boolean(map && (map.meshids || []).some((m) => meshAccessible(user, m))));
            }
            return clientCache.get(client);
        }
        async function nodeReadable(nodeid) {
            if (!nodeid) return false;
            if (!nodeCache.has(nodeid)) nodeCache.set(nodeid, await nodeVisible(session, nodeid));
            return nodeCache.get(nodeid);
        }
        async function canRead(path, nodeid) {
            if (readAll) return true;
            return (await nodeReadable(nodeid)) || (await clientReadable(lib.clientOf(path)));
        }
        return {
            domain, user, admin, readAll, canRead, clientReadable,
            // Device lists follow MeshCentral rights only; can_read_all covers notes, not devices.
            meshVisible: (meshid) => admin || meshAccessible(user, meshid),
            canWrite: async (path, nodeid) => (admin || perm('can_write')) && canRead(path, nodeid),
            canManage: admin || perm('can_manage'),
            nodeReadable,
            perms: admin ? ['*'] : perm('_ALL_'),
        };
    }

    async function readableNotes(access) {
        const all = await dbAll('mcpnote', access.domain);
        const out = [];
        for (const n of all) if (await access.canRead(n.path, n.nodeid)) out.push(n);
        out.sort((a, b) => a.path.localeCompare(b.path));
        return out;
    }

    async function requireNote(access, path) {
        const note = await dbGet(noteId(access.domain, path));
        // Same answer for "missing" and "not allowed" so paths cannot be probed.
        if (!note || !(await access.canRead(note.path, note.nodeid))) throw new Error(`note not found: ${path}`);
        return note;
    }

    function fullNote(n) {
        return Object.assign(lib.summary(n), { body: n.body, nodeids: n.nodeids || [], email: n.email || null, created: n.created, createdBy: n.createdBy });
    }

    // ── live MeshCentral data: clients, devices, logons ──────────────────────
    const seenId = (domain, nodeid) => `mcpnotesseen/${domain}/${nodeid}`;
    const SEEN_REFRESH_MS = 60 * 60 * 1000;

    async function clientMaps(domain) {
        const maps = await dbAll('mcpnotesclient', domain);
        return new Map(maps.map((m) => [m.client.toLowerCase(), m]));
    }

    // Clients whose mapped groups include this device group.
    function clientsOfMesh(maps, meshid) {
        return [...maps.values()].filter((m) => (m.meshids || []).includes(meshid)).map((m) => m.client);
    }

    function online(nodeid) {
        const web = root.webserver;
        return Boolean(web && web.wsagents && web.wsagents[nodeid]);
    }

    function meshName(meshid) {
        const mesh = root.webserver && root.webserver.meshes && root.webserver.meshes[meshid];
        return mesh ? mesh.name : meshid;
    }

    // Logons recorded for a device, plus whoever the node record says is logged on now.
    function logonsOf(node, seen) {
        const out = new Map();
        for (const s of (seen && seen.logons) || []) out.set(s.key, Object.assign({}, s, { now: false }));
        for (const n of [...(node.users || []), ...(node.upnusers || [])]) {
            const key = String(n).toLowerCase();
            out.set(key, Object.assign({ name: n, first: null, last: null }, out.get(key) || {}, { now: true }));
        }
        return [...out.values()];
    }

    function matchesUser(userNote, logonName) {
        const names = new Set(userNote.names || []);
        return lib.logonForms(logonName).some((f) => names.has(f));
    }

    // Record who is logged on to a device (agent coreinfo). Written only when a new
    // name appears or a last-seen time is more than an hour old. Stored as an array:
    // logon names contain dots, which MongoDB does not want in field names.
    function recordLogons(domain, nodeid, meshid, names) {
        if (!names.length) return Promise.resolve();
        return queued(async () => {
            const id = seenId(domain, nodeid);
            const doc = (await dbGet(id)) || { _id: id, domain, nodeid, logons: [] };
            const now = new Date().toISOString();
            let changed = doc.meshid !== meshid;
            Object.assign(doc, { type: 'mcpnotesseen', meshid, logons: doc.logons || [] });
            for (const name of names) {
                const key = String(name).toLowerCase().slice(0, 200);
                const s = doc.logons.find((x) => x.key === key);
                if (!s) { doc.logons.push({ key, name: String(name).slice(0, 200), first: now, last: now }); changed = true; }
                else if (Date.parse(now) - Date.parse(s.last) > SEEN_REFRESH_MS) { s.last = now; changed = true; }
            }
            if (doc.logons.length > 200) doc.logons = doc.logons.sort((a, b) => b.last.localeCompare(a.last)).slice(0, 200);
            if (changed) await dbSet(doc);
        });
    }

    // ── writes ───────────────────────────────────────────────────────────────
    function actorOf(session, command) {
        const via = typeof command.via === 'string' ? command.via.trim().slice(0, 100) : '';
        return { by: session.user.name || session.user._id, userid: session.user._id, via: via || null };
    }

    async function save(access, session, command, path, existing, body, nodeid) {
        const now = new Date().toISOString();
        const actor = actorOf(session, command);
        const rev = existing ? existing.rev + 1 : 1;
        if (existing) {
            await dbSet(Object.assign({}, existing, { _id: histId(access.domain, path, existing.rev), type: 'mcpnotehist' }));
            const old = existing.rev + 1 - lib.HISTORY_KEEP;
            if (old >= 1) await dbRemove(histId(access.domain, path, old)).catch(() => {});
        }
        const kind = lib.kindOf(path);
        const ident = kind === 'user' ? lib.userIdentities(path, body) : null;
        const note = {
            _id: noteId(access.domain, path), type: 'mcpnote', domain: access.domain,
            path: existing ? existing.path : path,
            client: lib.clientOf(path), kind, title: lib.titleOf(path, body),
            body, nodeid: nodeid || null, nodeids: lib.extractNodeIds(body), links: lib.linkedPaths(path, body),
            email: ident ? ident.email : null, names: ident ? ident.names : undefined, rev,
            created: existing ? existing.created : now, createdBy: existing ? existing.createdBy : actor.by,
            updated: now, updatedBy: actor.by, updatedByUserId: actor.userid, via: actor.via,
            message: typeof command.message === 'string' ? command.message.slice(0, 500) : null,
        };
        await dbSet(note);
        return note;
    }

    async function resolveNodeid(access, command, existing) {
        if (command.nodeid === undefined) return existing ? existing.nodeid : null;
        if (command.nodeid === null || command.nodeid === '') return null;
        if (typeof command.nodeid !== 'string' || !command.nodeid.startsWith(`node/${access.domain}/`)) throw new Error('invalid nodeid');
        if (!(await access.nodeReadable(command.nodeid))) throw new Error('no access to that device');
        return command.nodeid;
    }

    // ── operations ───────────────────────────────────────────────────────────
    const ops = {
        async whoami(command, session, access) {
            return { plugin: 'mcpnotes', version: require('./config.json').version, user: session.user.name, admin: access.admin, permissions: access.perms };
        },

        async list(command, session, access) {
            const prefix = lib.normalizePrefix(command.prefix);
            const notes = (await readableNotes(access))
                .filter((n) => !prefix || n.path.toLowerCase().startsWith(prefix.toLowerCase()))
                .filter((n) => !command.kind || n.kind === command.kind);
            return { notes: notes.map(lib.summary) };
        },

        async get(command, session, access) {
            const path = lib.normalizePath(command.path);
            const note = await requireNote(access, path);
            if (command.rev != null && Number(command.rev) !== note.rev) {
                const old = await dbGet(histId(access.domain, path, Number(command.rev)));
                if (!old) throw new Error(`revision ${command.rev} of ${path} is not kept`);
                return { note: fullNote(old) };
            }
            return { note: fullNote(note) };
        },

        // Everything known about a device: notes linked to it, notes that mention it,
        // and the index of each client those notes belong to.
        async fornode(command, session, access) {
            const nodeid = command.nodeid;
            if (typeof nodeid !== 'string' || !(await access.nodeReadable(nodeid))) throw new Error('no access to that device');
            const node = (await dbGet(nodeid)) || { _id: nodeid };
            const maps = await clientMaps(access.domain);
            const all = await readableNotes(access);
            const notes = all.filter((n) => n.nodeid === nodeid || (n.nodeids || []).includes(nodeid));
            const mapped = clientsOfMesh(maps, node.meshid);
            const clients = new Set([...mapped, ...notes.map((n) => n.client).filter(Boolean)]);
            const index = [...clients]
                .map((client) => all.find((n) => n.path.toLowerCase() === `${client}/servers.md`.toLowerCase()))
                .filter(Boolean);
            const userNotes = all.filter((n) => n.kind === 'user' && mapped.some((c) => c.toLowerCase() === n.client.toLowerCase()));
            const logons = logonsOf(node, await dbGet(seenId(access.domain, nodeid))).map((l) => ({
                name: l.name, first: l.first, last: l.last, now: l.now,
                user: (userNotes.find((u) => matchesUser(u, l.name)) || {}).path || null,
            }));
            return {
                device: notes.filter((n) => n.nodeid === nodeid).map(fullNote),
                mentions: notes.filter((n) => n.nodeid !== nodeid && !index.includes(n)).map(fullNote),
                index: index.map(fullNote), clients: [...clients], logons,
            };
        },

        // A client as MeshCentral sees it now, joined with its notes. The device list is
        // built live from the mapped groups; nothing about it is stored, so it cannot drift.
        async client(command, session, access) {
            const name = lib.normalizePrefix(command.client).replace(/\/$/, '');
            if (!name || name.includes('/')) throw new Error('client must be a single folder name');
            const key = name.toLowerCase();
            const maps = await clientMaps(access.domain);
            const map = maps.get(key);
            if (!access.readAll && !(await access.clientReadable(name))) throw new Error(`client not found: ${name}`);
            const meshids = ((map && map.meshids) || []).filter(access.meshVisible);
            const allNodes = await dbAll('node', access.domain);
            const nodeIds = new Set(allNodes.map((n) => n._id));
            const nodes = allNodes.filter((n) => meshids.includes(n.meshid));
            const here = new Set(nodes.map((n) => n._id));
            const notes = (await readableNotes(access)).filter((n) => (n.client || '').toLowerCase() === key);
            const seen = new Map((await dbAll('mcpnotesseen', access.domain)).map((s) => [s.nodeid, s]));
            const users = notes.filter((n) => n.kind === 'user');
            const deviceNotes = notes.filter((n) => n.kind === 'device');
            const devices = nodes.map((n) => {
                const note = deviceNotes.find((d) => d.nodeid === n._id);
                return {
                    nodeid: n._id, name: n.name, group: meshName(n.meshid), os: n.osdesc || null, online: online(n._id),
                    note: note ? note.path : null,
                    logons: logonsOf(n, seen.get(n._id)).map((l) => ({ name: l.name, last: l.last, now: l.now, user: (users.find((u) => matchesUser(u, l.name)) || {}).path || null })),
                };
            }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
            const index = notes.find((n) => n.kind === 'index');
            return {
                client: map ? map.client : name, mapped: Boolean(map),
                groups: meshids.map((id) => ({ meshid: id, name: meshName(id) })),
                devices,
                index: index ? fullNote(index) : null,
                users: users.map((u) => Object.assign(lib.summary(u), { email: u.email || null })),
                notes: notes.filter((n) => n.kind === 'note').map(lib.summary),
                issues: {
                    devicesWithoutNote: devices.filter((d) => !d.note).map((d) => d.name),
                    notesForRemovedDevices: deviceNotes.filter((d) => d.nodeid && !nodeIds.has(d.nodeid)).map((d) => d.path),
                    notesForDevicesOutsideClient: deviceNotes.filter((d) => d.nodeid && nodeIds.has(d.nodeid) && !here.has(d.nodeid)).map((d) => d.path),
                    deviceNotesNotLinked: deviceNotes.filter((d) => !d.nodeid).map((d) => d.path),
                },
            };
        },

        // Where a user has actually logged on (from MeshCentral) versus the devices the
        // note lists (links to device notes or node IDs in its body).
        async foruser(command, session, access) {
            const path = lib.normalizePath(command.path);
            const note = await requireNote(access, path);
            if (note.kind !== 'user') throw new Error(`${note.path} is not a user note (<Client>/users/<user>.md)`);
            const maps = await clientMaps(access.domain);
            const map = maps.get((note.client || '').toLowerCase());
            const meshids = ((map && map.meshids) || []).filter(access.meshVisible);
            const nodes = (await dbAll('node', access.domain)).filter((n) => meshids.includes(n.meshid));
            const seen = new Map((await dbAll('mcpnotesseen', access.domain)).map((s) => [s.nodeid, s]));
            const seenOn = [];
            for (const n of nodes) {
                for (const l of logonsOf(n, seen.get(n._id))) {
                    if (matchesUser(note, l.name)) seenOn.push({ nodeid: n._id, name: n.name, logon: l.name, first: l.first, last: l.last, now: l.now, online: online(n._id) });
                }
            }
            const listed = new Map();
            for (const id of note.nodeids || []) listed.set(id, { nodeid: id, via: 'node ID' });
            for (const link of note.links || []) {
                const target = await dbGet(`mcpnote/${access.domain}/${link}`);
                if (target && target.nodeid) listed.set(target.nodeid, { nodeid: target.nodeid, via: target.path });
            }
            const nameOf = (id) => (nodes.find((n) => n._id === id) || {}).name || id;
            const seenIds = new Set(seenOn.map((s) => s.nodeid));
            return {
                path: note.path, email: note.email || null, matchedBy: note.names || [],
                seenOn: seenOn.sort((a, b) => String(b.last || '9').localeCompare(String(a.last || '9'))),
                listed: [...listed.values()].map((l) => Object.assign(l, { name: nameOf(l.nodeid) })),
                seenNotListed: [...seenIds].filter((id) => !listed.has(id)).map(nameOf),
                listedNotSeen: [...listed.keys()].filter((id) => !seenIds.has(id)).map(nameOf),
            };
        },

        // Fold one user note into another (duplicates for the same person), or move it
        // when the target does not exist yet (e.g. rename to <email>.md). The source is
        // deleted with its last revision kept in history.
        async merge(command, session, access) {
            if (!access.canManage) throw new Error('merging notes needs the "Manage notes" permission');
            const fromPath = lib.normalizePath(command.from);
            const intoPath = lib.normalizePath(command.into);
            if (fromPath.toLowerCase() === intoPath.toLowerCase()) throw new Error('from and into are the same note');
            if (lib.clientOf(fromPath).toLowerCase() !== lib.clientOf(intoPath).toLowerCase()) throw new Error('notes can only be merged within one client folder');
            return queued(async () => {
                const from = await requireNote(access, fromPath);
                const into = await dbGet(noteId(access.domain, intoPath));
                if (into && !(await access.canRead(into.path, into.nodeid))) throw new Error('no access to that note');
                let body;
                if (!into) {
                    body = from.body;
                } else {
                    const a = lib.parseMeta(into.body);
                    const b = lib.parseMeta(from.body);
                    const aliases = [...new Set([...(a.aliases || []), ...(b.aliases || []), ...(b.email && b.email !== a.email ? [b.email] : []), from.path.split('/').pop().replace(/\.md$/i, '')])];
                    const meta = Object.assign({}, b, a, { email: a.email || b.email, aliases });
                    const date = new Date().toISOString().slice(0, 10);
                    body = lib.appendToSection(lib.setMeta(into.body, meta), `## Merged from ${from.path} (${date})`, lib.demoteHeadings(lib.stripMeta(from.body).trim()));
                }
                lib.checkBody(body);
                const saved = await save(access, session, Object.assign({}, command, { message: `merged from ${from.path}` }), intoPath, into, body, into ? into.nodeid : from.nodeid);
                await dbSet(Object.assign({}, from, { _id: histId(access.domain, from.path, from.rev), type: 'mcpnotehist' }));
                await dbRemove(from._id);
                return { note: lib.summary(saved), removed: from.path, moved: !into };
            });
        },

        async search(command, session, access) {
            const prefix = lib.normalizePrefix(command.prefix);
            const notes = (await readableNotes(access)).filter((n) => !prefix || n.path.toLowerCase().startsWith(prefix.toLowerCase()));
            return { results: lib.search(notes, command.query, { limit: Math.min(Number(command.limit) || 20, 100) }) };
        },

        // Full replace with optimistic concurrency: baseRev must equal the current rev
        // (0 to create). A stale baseRev returns the current rev so the caller can re-read.
        async put(command, session, access) {
            const path = lib.normalizePath(command.path);
            const body = lib.checkBody(command.body);
            return queued(async () => {
                const existing = await dbGet(noteId(access.domain, path));
                const visible = existing && (await access.canRead(existing.path, existing.nodeid));
                const current = visible ? existing.rev : 0;
                if (existing && !visible) throw new Error('no access to that note');
                if (Number(command.baseRev) !== current) {
                    const err = new Error(`conflict: ${path} is at rev ${current}, not ${command.baseRev}; read it again and re-apply your change`);
                    err.currentRev = current;
                    throw err;
                }
                const nodeid = await resolveNodeid(access, command, existing);
                if (!(await access.canWrite(path, nodeid))) throw new Error('no write access to that note');
                const note = await save(access, session, command, path, existing, body, nodeid);
                return { note: lib.summary(note), created: !existing };
            });
        },

        // Append text under a heading (default "## Log"); creates the note if missing.
        async append(command, session, access) {
            const path = lib.normalizePath(command.path);
            if (typeof command.text !== 'string' || !command.text.trim()) throw new Error('text is required');
            return queued(async () => {
                const existing = await dbGet(noteId(access.domain, path));
                if (existing && !(await access.canRead(existing.path, existing.nodeid))) throw new Error('no access to that note');
                const nodeid = await resolveNodeid(access, command, existing);
                if (!(await access.canWrite(path, nodeid))) throw new Error('no write access to that note');
                const base = existing ? existing.body : `# ${path.split('/').pop().replace(/\.md$/i, '')}\n`;
                const body = lib.checkBody(lib.appendToSection(base, command.heading, command.text));
                const note = await save(access, session, command, path, existing, body, nodeid);
                return { note: lib.summary(note), created: !existing };
            });
        },

        async history(command, session, access) {
            const path = lib.normalizePath(command.path);
            const note = await requireNote(access, path);
            const revs = [lib.summary(note)];
            for (let rev = note.rev - 1; rev >= Math.max(1, note.rev - lib.HISTORY_KEEP); rev--) {
                const old = await dbGet(histId(access.domain, path, rev));
                if (old) revs.push(lib.summary(old));
            }
            return { revisions: revs };
        },

        async delete(command, session, access) {
            if (!access.canManage) throw new Error('deleting notes needs the "Manage notes" permission');
            const path = lib.normalizePath(command.path);
            return queued(async () => {
                const note = await requireNote(access, path);
                if (Number(command.baseRev) !== note.rev) throw new Error(`conflict: ${path} is at rev ${note.rev}`);
                // Keep the last version as history so a delete can be undone with get rev + put.
                await dbSet(Object.assign({}, note, { _id: histId(access.domain, path, note.rev), type: 'mcpnotehist' }));
                await dbRemove(note._id);
                return { deleted: path, lastRev: note.rev };
            });
        },

        async clients(command, session, access) {
            const maps = await dbAll('mcpnotesclient', access.domain);
            const out = [];
            for (const m of maps) {
                if (access.readAll || (m.meshids || []).some((id) => meshAccessible(access.user, id))) {
                    out.push({ client: m.client, meshids: access.canManage ? m.meshids : undefined });
                }
            }
            return { clients: out.sort((a, b) => a.client.localeCompare(b.client)) };
        },

        async setclient(command, session, access) {
            if (!access.canManage) throw new Error('mapping clients needs the "Manage notes" permission');
            const client = lib.normalizePrefix(command.client).replace(/\/$/, '');
            if (!client || client.includes('/')) throw new Error('client must be a single folder name');
            const meshids = Array.isArray(command.meshids) ? command.meshids.filter((m) => typeof m === 'string' && m.startsWith(`mesh/${access.domain}/`)) : [];
            const doc = { _id: clientId(access.domain, client), type: 'mcpnotesclient', domain: access.domain, client, meshids, updated: new Date().toISOString(), updatedBy: session.user.name };
            await dbSet(doc);
            return { client, meshids };
        },
    };

    function reply(session, command, ok, result, error) {
        try {
            session.ws.send(JSON.stringify({
                action: 'plugin', plugin: 'mcpnotes', op: command.op,
                responseid: command.responseid, tag: command.tag,
                ok, result: result || null, error: error || null,
            }));
        } catch (e) { log('unable to send reply', e); }
    }

    plugin.serveraction = function serveraction(command, session) {
        if (!session || !session.user || !session.domain || !session.ws) return;
        if (typeof command.op !== 'string' || !Object.prototype.hasOwnProperty.call(ops, command.op)) {
            return reply(session, command, false, null, `unknown op "${command.op}"`);
        }
        const op = ops[command.op];
        accessFor(session)
            .then((access) => op(command, session, access))
            .then((result) => reply(session, command, true, result, null))
            .catch((err) => {
                if (!/^(conflict|note not found|no |invalid|path|body|text|query|client|revision|deleting|mapping|merging|notes can|from and)/.test(err.message || '')) log(`op ${command.op} failed`, err);
                reply(session, command, false, err.currentRev != null ? { currentRev: err.currentRev } : null, err.message || String(err));
            });
    };

    // Agents report who is logged on in coreinfo; keep a first/last-seen record per device.
    plugin.hook_processAgentData = function hookProcessAgentData(command, agent) {
        if (!command || command.action !== 'coreinfo' || !agent || !agent.dbNodeKey) return;
        const names = [command.users, command.upnusers]
            .flatMap((list) => (Array.isArray(list) ? list : []))
            .filter((n) => typeof n === 'string' && n.trim());
        if (!names.length) return;
        recordLogons(agent.domain ? agent.domain.id : '', agent.dbNodeKey, agent.dbMeshKey, names)
            .catch((err) => log(`recording logons for ${agent.dbNodeKey} failed`, err));
    };

    plugin.server_startup = function serverStartup() {
        registerPermissions();
    };

    return plugin;
};
