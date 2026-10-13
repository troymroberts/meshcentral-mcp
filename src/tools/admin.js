import { z } from 'zod';
import { serverResult } from '../safety.js';

// A — administration
export default function register(ctx) {
  const { define, client, meshId, resolveNodeId } = ctx;

  // ════════════════════════════════════════════════════════════════════════
  // A — estate / IAM administration
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_create_user', tier: 'A', title: 'Create user',
    description: 'Create a new user account.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ username }) => `Create user "${username}"`,
    schema: {
      username: z.string().describe('Username'),
      password: z.string().describe('Password'),
      email: z.string().optional().describe('Email address'),
      realname: z.string().optional().describe('Real name'),
    },
    handler: async ({ username, password, email, realname }) => {
      const cmd = { action: 'adduser', username, pass: password };
      if (email) cmd.email = email;
      if (realname) cmd.realname = realname;
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_delete_user', tier: 'A', title: 'Delete user',
    description: 'Delete a user account.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ userid }) => `Delete user ${userid}`,
    schema: { userid: z.string().describe('User ID (e.g. "user/domain/username")') },
    handler: async ({ userid }) => serverResult(await client.sendCommand({ action: 'deleteuser', userid }, 15_000)),
  });

  define({
    name: 'mesh_add_user_to_group', tier: 'A', title: 'Grant group access',
    description:
      'Grant a user rights to a device group. Rights bitmask: 1 editGroup, 2 manageUsers, 4 manageComputers, ' +
      '8 remoteControl, 16 agentConsole, 32 remoteCommands, 64 resetPowerOff, 128 viewOnly, 256 noTerminal, ' +
      '512 noDesktop, 1024 noFiles, 2048 noAMT, 4096 limitedInput, 8192 noClipboard, 16384 chat, 32768 wol, ' +
      '65536 noRemoteCmd. 4294967295 = full.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ user_id, mesh_id, rights }) => `Grant ${user_id} rights ${rights} on group ${mesh_id}`,
    schema: {
      user_id: z.string().describe('User ID or username'),
      mesh_id: z.string().describe('Device group ID or name'),
      rights: z.number().int().describe('Rights bitmask (4294967295 = full)'),
    },
    handler: async ({ user_id, mesh_id, rights }) =>
      serverResult(await client.sendCommand({ action: 'addmeshuser', meshid: meshId(mesh_id), userids: [user_id], meshadmin: rights }, 15_000)),
  });

  define({
    name: 'mesh_remove_user_from_group', tier: 'A', title: 'Revoke group access',
    description: "Remove a user's access to a device group.",
    annotations: { destructiveHint: true },
    confirmSummary: ({ user_id, mesh_id }) => `Revoke ${user_id} from group ${mesh_id}`,
    schema: {
      user_id: z.string().describe('User ID or username'),
      mesh_id: z.string().describe('Device group ID or name'),
    },
    handler: async ({ user_id, mesh_id }) =>
      serverResult(await client.sendCommand({ action: 'removemeshuser', meshid: meshId(mesh_id), userid: user_id }, 15_000)),
  });

  define({
    name: 'mesh_add_device_user', tier: 'A', title: 'Grant device access',
    description: 'Grant or remove a user a direct link to one device. Rights bits 0-2 are not allowed on device links.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ user_id, node_id, remove }) => `${remove ? 'Remove' : 'Grant'} ${user_id} access to device ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      user_id: z.string().describe('User ID or username'),
      rights: z.number().int().describe('Rights bitmask'),
      remove: z.boolean().optional().describe('Set true to remove the link'),
    },
    handler: async ({ node_id, user_id, rights, remove }) =>
      serverResult(await client.sendCommand({ action: 'adddeviceuser', nodeid: await resolveNodeId(node_id), userids: [user_id], rights, ...(remove ? { remove: true } : {}) }, 15_000)),
  });

  define({
    name: 'mesh_create_user_group', tier: 'A', title: 'Create user group',
    description: 'Create a user group.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ name }) => `Create user group "${name}"`,
    schema: {
      name: z.string().describe('User group name'),
      description: z.string().optional().describe('Description'),
    },
    handler: async ({ name, description }) => {
      const cmd = { action: 'createusergroup', name };
      if (description) cmd.desc = description;
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_delete_user_group', tier: 'A', title: 'Delete user group',
    description: 'Delete a user group.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ ugrp_id }) => `Delete user group ${ugrp_id}`,
    schema: { ugrp_id: z.string().describe('User group ID (ugrp/...)') },
    handler: async ({ ugrp_id }) => serverResult(await client.sendCommand({ action: 'deleteusergroup', ugrpid: ugrp_id }, 15_000)),
  });

  define({
    name: 'mesh_scan_amt', tier: 'A', title: 'Scan Intel AMT',
    description: 'Scan a network range for Intel AMT devices.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ iprange }) => `Scan ${iprange} for Intel AMT`,
    schema: { iprange: z.string().describe('IP range (e.g. "192.168.1.0/24")') },
    handler: async ({ iprange }) => serverResult(await client.sendCommand({ action: 'scanamtdevice', iprange }, 30_000)),
  });

  define({
    name: 'mesh_server_console', tier: 'A', title: 'Server console',
    description: 'Run a server console command (e.g. "help", "dbstats", "usersessions", "certexpire").',
    annotations: { destructiveHint: true },
    confirmSummary: ({ command }) => `Server console: ${command}`,
    schema: { command: z.string().describe('Server console command') },
    handler: async ({ command }) => serverResult(await client.sendCommand({ action: 'serverconsole', value: command }, 20_000)),
  });
}
