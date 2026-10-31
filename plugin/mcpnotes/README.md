# mcpnotes — server-side notes for the MeshCentral MCP

A MeshCentral plugin that keeps the team's Markdown notes about clients, devices and
end users **in MeshCentral's own database**, so every technician's MCP session reads
and updates the same notes. Today those notes live in a local folder
(a folder of Markdown files) that only one workstation sees.

It adds **nothing to the web UI**: no admin panel, no device tab and no browser code.
The notes are reachable only through the control websocket the MCP already uses:

```json
{ "action": "plugin", "plugin": "mcpnotes", "op": "get", "path": "ACME/servers.md", "responseid": "…" }
```

MeshCentral stamps `command.userid` and routes the message to `serveraction(command, session)`
(`meshuser.js`, `case 'plugin'`). The plugin replies on the same socket with
`{ action: 'plugin', plugin: 'mcpnotes', op, responseid, ok, result, error }`.

## Layout

Paths mirror the existing notes folder, so nothing has to be reorganised:

| Path | Kind |
|---|---|
| `<Client>/servers.md` | `index`: client inventory, node IDs, client-wide log |
| `<Client>/devices/<device>.md` | `device`: linked to one node (`nodeid`) |
| `<Client>/users/<user>.md` | `user`: one end user |
| anything else (`security/<topic>.md`, `<Client>/<topic>.md`) | `note` |

Path rules: at most 4 segments of `[A-Za-z0-9 ._@()-]`, no `..` or leading dot,
must end in `.md`, at most 200 characters. Lookups ignore case and the original
casing is kept. Bodies can be up to 512 KB.

## Storage

All records go in MeshCentral's main collection through `db.Get/Set/Remove/GetAllTypeNoTypeField`,
like the Inventory plugin, so this works on NeDB, MongoDB and the SQL backends and is
covered by MeshCentral's normal backups (`mongodump` here).

| `_id` | `type` | |
|---|---|---|
| `mcpnote/<domain>/<lower-case path>` | `mcpnote` | current note |
| `mcpnotehist/<domain>/<lower-case path>@<rev>` | `mcpnotehist` | previous revisions (last 25 kept) |
| `mcpnotesclient/<domain>/<lower-case client>` | `mcpnotesclient` | client folder → device groups |
| `mcpnotesseen/<domain>/<nodeid>` | `mcpnotesseen` | logons seen on a device (name, first, last; max 200) |

Each note records `rev`, `created/createdBy`, `updated/updatedBy` (the MeshCentral account),
`via` (which MCP install and OS user wrote it, since several people may share one bot token),
an optional change `message`, and `nodeids`: every node ID mentioned in the body, which
`fornode` uses to find the notes that mention a device.

## Company and user data

Device notes are easy: one note per node, linked by `nodeid`. Companies and people are not
objects in MeshCentral, so they are handled differently, with the aim that nothing which
MeshCentral already knows is copied into a note (copies are what drift).

**Company = client folder + mapped device groups.** The mapping record is the company.
`client` builds the device list **live** from the mapped groups every time (name, group,
OS, online, who logs on, which note covers it) and joins it with the notes. It also flags
gaps: devices without a note, notes for devices that were removed or moved out of the
client's groups, and device notes not linked to a node. So `<Client>/servers.md` only
needs what MeshCentral cannot know: contacts, sites and network, client-wide decisions,
the dated log and open actions. Device tables already in it keep working (their node IDs
make `fornode` find the index) but no longer have to be maintained.

**User = identity, not file name.** A user note is matched to logons by:
- optional frontmatter: `email:` and `aliases:` (`DOMAIN\user`, UPN, display name);
- cues existing notes already have in their first lines: an email in the title or a
  `Mailbox:`/`Email:` line, and back-ticked names on `AD account:`/`login:`/`username:` lines;
- the file name.

Names match case-insensitively, with or without `DOMAIN\` or `@domain`, and only against
devices of the note's own client, so a short name like `sam` cannot match another
company. New notes should be `<Client>/users/<email>.md` with frontmatter. Existing notes
match as they are, and `merge` into a new path renames them.

**Where a user was actually seen comes from MeshCentral.** The plugin's
`hook_processAgentData` records every logon an agent reports in `coreinfo` (first/last
seen per device; rewritten at most hourly per name). The device record's current
`users`/`upnusers` count as "logged on now". `foruser` compares those devices with the ones
the note lists (relative links to device notes, such as `[ACME-TS](../devices/ACME-TS.md)`,
or node IDs) and reports both differences. Nothing is changed automatically; a
technician decides whether the note or the person's habits are out of date. Logon history
starts when the plugin is installed.

**Duplicates are merged by a person, never automatically.** `merge` folds one note into
another in the same client folder: aliases are combined and the source body goes under
`## Merged from <path> (<date>)` with its headings nested. The source is removed and its
last revision kept in history.

## Access

| Who | Can |
|---|---|
| Full site admin | everything |
| `can_read_all` permission | read every note |
| Rights on a device | read notes linked to that device |
| Rights on **any** device group mapped to a client folder | read every note in that folder |
| `can_write` permission (default: allowed) | create/update notes the user can read |
| `can_manage` permission | delete notes, map client folders to groups |

A client folder belongs to nobody until an admin maps it (`setclient`, or the MCP's
`mesh_notes_map_client`). Unmapped folders and top-level notes are admin-only (or
`can_read_all`). When a user may not read a note, the plugin says "not found", so paths
cannot be probed. On a MeshCentral without the plugin-permissions API, the defaults apply.

## Operations

| op | Arguments | Result |
|---|---|---|
| `whoami` | | plugin version, user, permissions; use as an "is it installed?" check |
| `list` | `prefix?`, `kind?` | summaries of readable notes |
| `get` | `path`, `rev?` | full note (or an older revision) |
| `fornode` | `nodeid` | `device` notes, the client `index`, other notes that `mention` it, `logons` matched to user notes |
| `client` | `client` | live groups/devices joined with notes, `index`, `users`, `issues` |
| `foruser` | `path` | `seenOn` (MeshCentral logons), `listed` (from the note), `seenNotListed`, `listedNotSeen` |
| `merge` | `from`, `into` | `can_manage`; fold or move a note within one client folder |
| `search` | `query`, `prefix?`, `limit?` | matching lines per note; every word must appear |
| `put` | `path`, `body`, `baseRev`, `nodeid?`, `message?` | full replace; `baseRev` must equal the current rev (0 = create), otherwise `conflict` + `result.currentRev` |
| `append` | `path`, `text`, `heading?` (`## Log`), `nodeid?` | appends under the heading on the server, so concurrent log entries never conflict; creates the note/section if missing |
| `history` | `path` | revisions, newest first |
| `delete` | `path`, `baseRev` | `can_manage`; last revision kept in history |
| `clients` / `setclient` | `client`, `meshids` | list / set folder → groups mapping |

Writes are serialised inside the plugin, so read-modify-write is atomic on a single server.
With several MeshCentral peers, `baseRev` still catches overlapping full replaces, but two
simultaneous `append`s on different peers could lose one.

## Install (Plugins tab, same path as Inventory)

1. `config.json` → `settings.plugins: { "enabled": true }` is already set (Inventory runs).
   **Do not** use `settings.plugins.list` for this plugin: it replaces DB-based loading
   and would disable Inventory.
2. Snapshot the MeshCentral server first.
3. My Server → Plugins → Download plugin → config URL
   `https://raw.githubusercontent.com/troymroberts/meshcentral-mcp/master/plugin/mcpnotes/config.json`
   → Install → Enable. (MeshCentral restarts to load it.)
4. Lessons from Inventory that apply here: 1.3.0 requires `changelogUrl` (present); the
   zip needs explicit directory entries (`scripts/package-mcpnotes.sh` adds them); **Upgrade
   downloads the `downloadUrl` stored in the DB at install time**, so keep the URL stable
   (it is: `plugin/release-assets/MeshCentral-MCPNotes.zip` on master).
5. Map the client folders to their device groups (`mesh_notes_map_client`, admin profile).
6. Import the local notes: `node scripts/import-notes.mjs <notes-folder>` (dry run), then `--apply`.
   Files that look like they hold a secret are skipped; review them, then pass `--allow <path>`.
7. From then on the server is the source of truth; there is no two-way sync. Switch the local
   `mesh_preflight.py` / `mesh_notes_check.py` hooks to the MCP tools (`mesh_notes_for_device`
   before work, `mesh_notes_append` after), and archive the local folder.
   For a local copy, `node scripts/export-notes.mjs <empty-folder>` writes a one-way export.
   It refuses any folder that isn't empty or a previous export.

Rebuild the zip after any change to the plugin: `scripts/package-mcpnotes.sh`, and bump
`version` in `config.json` so the Plugins tab offers the upgrade.
