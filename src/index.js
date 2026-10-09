#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MeshCentralClient } from './mesh-client.js';
import { loadDotEnv, loadConfig } from './config.js';
import { Policy, ConfirmationGate, setMaxOutputChars } from './safety.js';
import { registerTools } from './register.js';

loadDotEnv();

const config = loadConfig();
if (config.error) {
  console.error(`[meshcentral-mcp] ${config.error}`);
  process.exit(1);
}

if (config.credentials.kind === 'login token' && !config.credentials.username.startsWith('~t:')) {
  console.error(
    `[meshcentral-mcp] WARNING: login token username '${config.credentials.username}' does not start with '~t:'. ` +
      'MeshCentral token usernames carry that prefix; authentication will probably fail.'
  );
}

setMaxOutputChars(config.maxOutputChars);

const client = new MeshCentralClient({
  serverUrl: config.serverUrl,
  username: config.credentials.username,
  password: config.credentials.password,
  rejectUnauthorized: config.rejectUnauthorized,
});

const server = new McpServer({ name: 'meshcentral-mcp', version: '2.0.0' });

let policy;
try {
  policy = new Policy({
    profile: config.profile,
    enableTools: config.enableTools,
    disableTools: config.disableTools,
    confirmTiers: config.confirmTiers,
  });
} catch (err) {
  console.error(`[meshcentral-mcp] ${err.message}`);
  process.exit(1);
}

let gate;
try {
  gate = new ConfirmationGate({ mode: config.confirmMode, server: server.server });
} catch (err) {
  console.error(`[meshcentral-mcp] ${err.message}`);
  process.exit(1);
}

const { registered, terminals, desktops } = registerTools({ server, client, policy, gate, config });

function shutdown() {
  try { terminals.closeAll(); } catch {}
  try { desktops.closeAll(); } catch {}
  try { client.disconnect(); } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  try {
    await client.connect();
    console.error('[meshcentral-mcp] Connected to MeshCentral');
  } catch (err) {
    console.error(`[meshcentral-mcp] Failed initial connect: ${err.message} (will retry on first command).`);
  }
  console.error(
    `[meshcentral-mcp] profile=${config.profile} tools=${registered.length} ` +
      `confirm=${config.confirmMode} fileRoot=${process.env.MESH_LOCAL_FILE_ROOT || 'mcp-files'}`
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`[meshcentral-mcp] Fatal: ${err.message}`);
  process.exit(1);
});
