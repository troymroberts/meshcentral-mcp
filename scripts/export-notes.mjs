#!/usr/bin/env node
// One-way export of the mcpnotes plugin's notes to a local folder (backup, grep, offline
// reading), using the MCP's credentials (.env / MESH_* variables). The server stays the
// source of truth: nothing is ever read back from the export.
//
//   node scripts/export-notes.mjs ~/notes-export            # every note you can read
//   node scripts/export-notes.mjs ~/notes-export --prefix ACME
//
// The target must be empty or a previous export (it holds .mcpnotes-export), so a live
// notes folder is never overwritten. Notes deleted on the server are removed from it.
import fs from 'fs';
import path from 'path';
import { loadDotEnv, loadConfig } from '../src/config.js';
import { MeshCentralClient } from '../src/mesh-client.js';

const args = process.argv.slice(2);
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--prefix');
const prefix = args.includes('--prefix') ? args[args.indexOf('--prefix') + 1] : undefined;
if (!target) {
  console.error('usage: export-notes.mjs <folder> [--prefix <Client>]');
  process.exit(2);
}
const dir = path.resolve(target);
const marker = path.join(dir, '.mcpnotes-export');
if (fs.existsSync(dir) && fs.readdirSync(dir).length && !fs.existsSync(marker)) {
  console.error(`${dir} is not empty and is not a previous export; refusing to write into it.`);
  process.exit(1);
}

loadDotEnv();
const config = loadConfig();
if (config.error) { console.error(config.error); process.exit(1); }
// Same mapping as src/index.js: loadConfig() nests the credentials.
const client = new MeshCentralClient({
  serverUrl: config.serverUrl,
  username: config.credentials.username,
  password: config.credentials.password,
  rejectUnauthorized: config.rejectUnauthorized,
});
await client.connect();

async function call(op, a) {
  const r = await client.sendCommand({ action: 'plugin', plugin: 'mcpnotes', op, via: 'export-notes', ...a }, 15_000);
  if (r?.plugin !== 'mcpnotes') throw new Error('unexpected reply (is the mcpnotes plugin installed?)');
  if (!r.ok) throw new Error(r.error);
  return r.result;
}

// Only prune files from an export of the same scope (same --prefix).
const last = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
const previous = last && (last.prefix || null) === (prefix || null) ? last.files || [] : [];
const written = [];
try {
  const { notes } = await call('list', { prefix });
  for (const s of notes) {
    const { note } = await call('get', { path: s.path });
    const file = path.join(dir, ...note.path.split('/'));
    if (!file.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, note.body);
    written.push(note.path);
  }
} finally {
  client.disconnect();
}
const removed = previous.filter((p) => !written.includes(p));
for (const p of removed) fs.rmSync(path.join(dir, ...p.split('/')), { force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(marker, JSON.stringify({ exported: new Date().toISOString(), server: config.serverUrl, prefix: prefix || null, files: written }, null, 2));
console.log(`Exported ${written.length} notes to ${dir}${removed.length ? `; removed ${removed.length} deleted on the server` : ''}.`);
