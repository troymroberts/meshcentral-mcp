#!/usr/bin/env node
// Copy a local notes folder into the mcpnotes plugin on the
// MeshCentral server, using the MCP's own credentials (.env / MESH_* variables).
//
//   node scripts/import-notes.mjs ~/notes                              # dry run: show the plan
//   node scripts/import-notes.mjs ~/notes --apply    # create new notes
//   ... --apply --overwrite   also replace notes whose server copy differs
//   ... --exclude CLAUDE.md --exclude security/   skip paths (prefix match)
//   ... --allow ACME/servers.md   import a file flagged as a possible secret after reviewing it
//
// Device notes (<Client>/devices/*.md) are linked to the first node ID in their
// first 15 lines. Files that look like they contain secrets are listed and skipped
// unless named with --allow.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { loadDotEnv, loadConfig } from '../src/config.js';
import { MeshCentralClient } from '../src/mesh-client.js';

const require = createRequire(import.meta.url);
const lib = require('../plugin/mcpnotes/lib/notes.js');

const args = process.argv.slice(2);
const valued = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const root = args.find((a, i) => !a.startsWith('--') && !['--exclude', '--allow'].includes(args[i - 1]));
const apply = args.includes('--apply');
const overwrite = args.includes('--overwrite');
const excludes = valued('--exclude');
const allowed = new Set(valued('--allow').map((p) => p.toLowerCase()));
if (!root) {
  console.error('usage: import-notes.mjs <notes-folder> [--apply] [--overwrite] [--exclude <prefix>]...');
  process.exit(2);
}

const SECRET = /(password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'logs' || e.name === 'node_modules') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(r);
  }
  return out;
}

loadDotEnv();
const config = loadConfig();
if (config.error) { console.error(config.error); process.exit(1); }
const client = new MeshCentralClient(config);
await client.connect();

async function call(op, a) {
  const r = await client.sendCommand({ action: 'plugin', plugin: 'mcpnotes', op, via: 'import-notes', ...a }, 15_000);
  if (r?.plugin !== 'mcpnotes') throw new Error('unexpected reply (is the mcpnotes plugin installed?)');
  if (!r.ok) { const e = new Error(r.error); e.currentRev = r.result?.currentRev; throw e; }
  return r.result;
}

const counts = { create: 0, same: 0, update: 0, differs: 0, skipped: 0, failed: 0 };
try {
  await call('whoami');
  for (const rel of walk(path.resolve(root)).sort()) {
    if (excludes.some((x) => rel.toLowerCase().startsWith(x.toLowerCase()))) continue;
    let notePath;
    try { notePath = lib.normalizePath(rel); } catch (e) { console.log(`SKIP     ${rel} (${e.message})`); counts.skipped++; continue; }
    const body = fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
    if (SECRET.test(body) && !allowed.has(rel.toLowerCase())) {
      console.log(`SKIP     ${rel} (may contain a secret — review it, then pass --allow ${rel})`);
      counts.skipped++;
      continue;
    }
    const nodeid = lib.kindOf(notePath) === 'device' ? lib.extractNodeIds(body.split('\n').slice(0, 15).join('\n'))[0] : undefined;

    let current = null;
    try { current = (await call('get', { path: notePath })).note; } catch (e) { if (!/not found/.test(e.message)) throw e; }
    let action;
    if (!current) action = 'create';
    else if (current.body === body) action = 'same';
    else action = overwrite ? 'update' : 'differs';
    const label = { create: 'CREATE  ', same: 'SAME    ', update: 'UPDATE  ', differs: 'DIFFERS ' }[action];
    console.log(`${label} ${notePath}${nodeid ? `  [${nodeid}]` : ''}${action === 'differs' ? ' (server copy changed; --overwrite to replace)' : ''}`);
    counts[action]++;
    if (!apply || action === 'same' || action === 'differs') continue;
    const put = (n) => call('put', { path: notePath, body, baseRev: current ? current.rev : 0, nodeid: n, message: 'import from local notes' });
    try {
      await put(nodeid).catch((e) => (nodeid && /device/.test(e.message) ? put(undefined) : Promise.reject(e)));
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      counts.failed++;
    }
  }
} finally {
  client.disconnect();
}
console.log(`\n${apply ? 'Applied' : 'Dry run'}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
