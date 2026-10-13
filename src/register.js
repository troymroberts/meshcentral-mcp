import { createContext } from './tools/context.js';
import inventory from './tools/inventory.js';
import remoteRead from './tools/remote-read.js';
import diagnostics from './tools/diagnostics.js';
import writes from './tools/writes.js';
import exec from './tools/exec.js';
import desktop from './tools/desktop.js';
import fileWrite from './tools/file-write.js';
import lifecycle from './tools/lifecycle.js';
import admin from './tools/admin.js';

// Registers every tool the policy allows. Each module adds one tier's tools via
// ctx.define(), which applies profile gating and confirmation uniformly.
export function registerTools({ server, client, policy, gate, config, audit }) {
  const ctx = createContext({ server, client, policy, gate, config, audit });
  for (const register of [inventory, remoteRead, diagnostics, writes, exec, desktop, fileWrite, lifecycle, admin]) register(ctx);
  return { registered: ctx.registered, terminals: ctx.terminals, desktops: ctx.desktops };
}
