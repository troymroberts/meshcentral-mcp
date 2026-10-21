import { createContext } from './tools/context.js';
import inventory from './tools/inventory.js';
import remoteRead from './tools/remote-read.js';
import software from './tools/software.js';
import registry from './tools/registry.js';
import assetInventory from './tools/asset-inventory.js';
import diagnostics from './tools/diagnostics.js';
import writes from './tools/writes.js';
import exec from './tools/exec.js';
import desktop from './tools/desktop.js';
import fileWrite from './tools/file-write.js';
import lifecycle from './tools/lifecycle.js';
import admin from './tools/admin.js';
import endUser from './tools/end-user.js';

// Registers every tool the policy allows. Each module adds one tier's tools via
// ctx.define(), which applies profile gating and confirmation uniformly.
export function registerTools({ server, client, policy, gate, config, audit }) {
  const ctx = createContext({ server, client, policy, gate, config, audit });
  for (const register of [inventory, remoteRead, software, registry, assetInventory, diagnostics, writes, exec, desktop, fileWrite, lifecycle, admin, endUser]) register(ctx);
  return { registered: ctx.registered, known: ctx.known, terminals: ctx.terminals, desktops: ctx.desktops, chats: ctx.chats };
}
