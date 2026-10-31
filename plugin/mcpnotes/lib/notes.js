'use strict';

// Pure helpers for the mcpnotes plugin: path rules, scoping, section edits and
// search. No MeshCentral objects here so they can be unit-tested on their own.

const MAX_PATH = 200;
const MAX_BODY = 512 * 1024;
const HISTORY_KEEP = 25;

// A note path mirrors a per-client notes folder:
//   <Client>/servers.md, <Client>/devices/<device>.md, <Client>/users/<user>.md,
//   or top-level shared notes such as security/<topic>.md.
// Segments: letters, digits, space . _ - @ ( ) ; no "..", no leading dot, ends in .md.
const SEGMENT = /^[A-Za-z0-9@()_][A-Za-z0-9 ._@()-]*$/;

function normalizePath(input) {
    if (typeof input !== 'string') throw new Error('path is required');
    const path = input.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path || path.length > MAX_PATH) throw new Error(`path must be 1-${MAX_PATH} characters`);
    const parts = path.split('/');
    if (parts.length > 4) throw new Error('path is too deep (max 4 segments)');
    for (const part of parts) {
        if (!SEGMENT.test(part) || part === '.' || part === '..' || part.endsWith(' ')) {
            throw new Error(`invalid path segment "${part}"`);
        }
    }
    if (!/\.md$/i.test(path)) throw new Error('path must end in .md');
    return path;
}

// Folder prefixes used for listing: same rules, no .md, trailing slash optional.
function normalizePrefix(input) {
    if (input == null || input === '') return '';
    if (typeof input !== 'string') throw new Error('prefix must be a string');
    const prefix = input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!prefix) return '';
    for (const part of prefix.split('/')) {
        if (!SEGMENT.test(part) || part === '..') throw new Error(`invalid prefix segment "${part}"`);
    }
    return prefix + '/';
}

// The client a note belongs to is its top-level folder; top-level files have none.
function clientOf(path) {
    const i = path.indexOf('/');
    return i > 0 ? path.slice(0, i) : '';
}

function kindOf(path) {
    const parts = path.split('/');
    if (parts.length === 2 && parts[1].toLowerCase() === 'servers.md') return 'index';
    if (parts.length === 3 && parts[1] === 'devices') return 'device';
    if (parts.length === 3 && parts[1] === 'users') return 'user';
    return 'note';
}

// Node IDs written in the body ("node//abc..." or "node/<domain>/abc..."). Used to
// find every note that mentions a device, like the local preflight hook did.
const NODE_ID = /node\/[A-Za-z0-9_-]*\/[A-Za-z0-9@$_-]{20,}/g;
function extractNodeIds(body) {
    const found = new Set();
    for (const m of String(body || '').matchAll(NODE_ID)) found.add(m[0]);
    return [...found];
}

function checkBody(body) {
    if (typeof body !== 'string') throw new Error('body must be a string');
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY) throw new Error(`body exceeds ${MAX_BODY / 1024} KB`);
    if (/\u0000/.test(body)) throw new Error('body contains NUL characters');
    return body;
}

function titleOf(path, body) {
    const m = /^#\s+(.+)$/m.exec(body || '');
    if (m) return m[1].trim().slice(0, 200);
    return path.split('/').pop().replace(/\.md$/i, '');
}

// Insert text at the end of a "## <heading>" section, creating the section at the
// end of the document if it is missing. Server-side so concurrent log entries from
// several technicians never conflict.
function appendToSection(body, heading, text) {
    const h = String(heading || '## Log').trim();
    const marker = /^#{1,6}\s/.test(h) ? h : `## ${h}`;
    const level = marker.match(/^#+/)[0].length;
    const entry = String(text).replace(/\s+$/, '');
    const lines = String(body || '').replace(/\s+$/, '').split('\n');
    const start = lines.findIndex((l) => l.trim().toLowerCase() === marker.toLowerCase());
    if (start < 0) {
        const head = lines.length === 1 && lines[0] === '' ? [] : [...lines, ''];
        return [...head, marker, '', entry, ''].join('\n');
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        const m = /^(#{1,6})\s/.exec(lines[i]);
        if (m && m[1].length <= level) { end = i; break; }
    }
    let at = end;
    while (at > start + 1 && lines[at - 1].trim() === '') at--;
    const out = [...lines.slice(0, at), entry, ...(end < lines.length ? [''] : []), ...lines.slice(end)];
    return out.join('\n').replace(/\s+$/, '') + '\n';
}

// Case-insensitive search; every term must appear in the note. Returns matching
// lines with a little context, best notes first.
function search(notes, query, { limit = 20, linesPerNote = 5 } = {}) {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) throw new Error('query is required');
    const results = [];
    for (const note of notes) {
        const hay = `${note.path}\n${note.body}`.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) continue;
        const lines = note.body.split('\n');
        const hits = [];
        let score = 0;
        lines.forEach((line, i) => {
            const l = line.toLowerCase();
            const n = terms.filter((t) => l.includes(t)).length;
            if (n) { score += n; if (hits.length < linesPerNote) hits.push({ line: i + 1, text: line.trim().slice(0, 300) }); }
        });
        if (terms.some((t) => note.path.toLowerCase().includes(t))) score += 5;
        results.push({ path: note.path, title: note.title, rev: note.rev, updated: note.updated, score, hits });
    }
    results.sort((a, b) => b.score - a.score || String(b.updated).localeCompare(String(a.updated)));
    return results.slice(0, limit);
}

// ── user identities ──────────────────────────────────────────────────────
// A user note is keyed by who the person is, not by its file name: optional
// frontmatter (email:, aliases:) plus the cues the notes already carry in their
// first lines (an email in the title, "AD account: `jdoe`", "Mailbox: x@y").

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function parseMeta(body) {
    const m = FRONTMATTER.exec(String(body || ''));
    const meta = {};
    if (!m) return meta;
    for (const line of m[1].split('\n')) {
        const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
        if (!kv) continue;
        const key = kv[1].toLowerCase();
        const value = kv[2].trim().replace(/^\[|\]$/g, '');
        meta[key] = key === 'aliases' ? value.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean) : value.replace(/^["']|["']$/g, '');
    }
    return meta;
}

function setMeta(body, meta) {
    const lines = [];
    if (meta.email) lines.push(`email: ${meta.email}`);
    if (meta.aliases && meta.aliases.length) lines.push(`aliases: ${meta.aliases.join(', ')}`);
    for (const [k, v] of Object.entries(meta)) if (k !== 'email' && k !== 'aliases' && v) lines.push(`${k}: ${v}`);
    const rest = String(body || '').replace(FRONTMATTER, '');
    return lines.length ? `---\n${lines.join('\n')}\n---\n${rest}` : rest;
}

const stripMeta = (body) => String(body || '').replace(FRONTMATTER, '');

// Lower-case forms a logon name can be matched by: "ACME\jdoe" -> acme\jdoe, jdoe;
// "jdoe@acme.com" -> jdoe@acme.com, jdoe.
function logonForms(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return [];
    const forms = new Set([n]);
    if (n.includes('\\')) forms.add(n.split('\\').pop());
    if (n.includes('@')) forms.add(n.split('@')[0]);
    return [...forms].filter((f) => f.length >= 2);
}

function userIdentities(path, body) {
    const meta = parseMeta(body);
    const head = stripMeta(body).split('\n').slice(0, 15);
    const out = { email: (meta.email || '').toLowerCase() || null, names: new Set() };
    const add = (v) => { for (const f of logonForms(v)) out.names.add(f); };
    if (meta.email) add(meta.email);
    for (const a of meta.aliases || []) add(a);
    for (const line of head) {
        if (/^#\s/.test(line) || /mailbox|e-?mail|upn/i.test(line)) for (const e of line.match(EMAIL) || []) { add(e); if (!out.email) out.email = e.toLowerCase(); }
        if (/ad account|login|logon|username|user name|upn|sam/i.test(line)) for (const m of line.matchAll(/`([^`\s]{2,64})`/g)) add(m[1]);
    }
    add(path.split('/').pop().replace(/\.md$/i, ''));
    return { email: out.email, names: [...out.names] };
}

// Notes a body links to with relative Markdown links ("](../devices/ACME-TS.md)"),
// resolved against the linking note's folder. Lower-case paths.
function linkedPaths(path, body) {
    const base = path.split('/').slice(0, -1);
    const out = new Set();
    for (const m of String(body || '').matchAll(/\]\(([^)#\s]+\.md)(#[^)]*)?\)/gi)) {
        if (/^[a-z]+:/i.test(m[1])) continue;
        const parts = m[1].startsWith('/') ? [] : [...base];
        for (const seg of decodeURIComponent(m[1]).split('/')) {
            if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
        }
        out.add(parts.join('/').toLowerCase());
    }
    return [...out];
}

// Push every heading down `by` levels (max ######) so merged text nests under a new heading.
function demoteHeadings(body, by = 2) {
    return String(body || '').replace(/^(#{1,6})(\s)/gm, (m, h, s) => '#'.repeat(Math.min(6, h.length + by)) + s);
}

function summary(note) {
    return {
        path: note.path,
        title: note.title,
        kind: note.kind,
        client: note.client,
        nodeid: note.nodeid || null,
        rev: note.rev,
        size: Buffer.byteLength(note.body || '', 'utf8'),
        updated: note.updated,
        updatedBy: note.updatedBy,
        message: note.message || null,
    };
}

module.exports = {
    MAX_BODY, HISTORY_KEEP,
    normalizePath, normalizePrefix, clientOf, kindOf, extractNodeIds, checkBody, titleOf,
    appendToSection, search, summary,
    parseMeta, setMeta, stripMeta, logonForms, userIdentities, linkedPaths, demoteHeadings,
};
