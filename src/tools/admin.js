import { z } from 'zod';
import { serverResult, errorResult } from '../safety.js';

// MeshCentral device-group rights (MESHRIGHT_* in meshcentral's meshuser.js).
export const MESH_RIGHTS = {
  edit_group: 1,
  manage_users: 2,
  manage_devices: 4,
  remote_control: 8,
  agent_console: 16,
  server_files: 32,
  wake_devices: 64,
  edit_notes: 128,
  remote_view_only: 256,
  no_terminal: 512,
  no_files: 1024,
  no_amt: 2048,
  limited_input: 4096,
  limit_events: 8192,
  chat_notify: 16384,
  uninstall: 32768,
  no_desktop: 65536,
  remote_commands: 131072,
  reset_power_off: 262144,
};
export const FULL_RIGHTS = 0xFFFFFFFF;
export const rightsMask = (names) => names.reduce((m, n) => m | MESH_RIGHTS[n], 0) >>> 0;
// Group-management rights cannot be put on a direct user-to-device link.
const GROUP_ONLY_RIGHTS = ['edit_group', 'manage_users', 'manage_devices'];
const DEVICE_RIGHTS = Object.keys(MESH_RIGHTS).filter((n) => !GROUP_ONLY_RIGHTS.includes(n));
const DEVICE_FULL_RIGHTS = (FULL_RIGHTS & ~7) >>> 0;

// A — administration
export default function register(ctx) {
  const { define, client, meshId, resolveNodeId } = ctx;
  // A bare username becomes a MeshCentral user ID (user/<domain>/<lowercased name>).
  const userId = (ref) => (String(ref).includes('/') ? ref : `user/${client.domain}/${String(ref).toLowerCase()}`);

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
      'Grant a user rights to a device group. Pass full_rights: true for full control, or list named rights. ' +
      'Restrictions (no_*, remote_view_only, limited_input, limit_events) take rights away: combine them with ' +
      'remote_control to grant restricted remote access.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ user_id, mesh_id, rights, full_rights }) =>
      `Grant ${user_id} ${full_rights ? 'FULL rights' : `rights [${(rights ?? []).join(', ')}]`} on group ${mesh_id}`,
    schema: {
      user_id: z.string().describe('User ID or username'),
      mesh_id: z.string().describe('Device group ID or name'),
      rights: z.array(z.enum(Object.keys(MESH_RIGHTS))).optional().describe('Named rights to grant'),
      full_rights: z.boolean().optional().describe('Grant full control of the group (overrides rights)'),
    },
    handler: async ({ user_id, mesh_id, rights, full_rights }) => {
      if (!full_rights && !rights?.length) return errorResult('Pass rights (a list of named rights) or full_rights: true.');
      const meshadmin = full_rights ? FULL_RIGHTS : rightsMask(rights);
      return serverResult(await client.sendCommand({ action: 'addmeshuser', meshid: meshId(mesh_id), userids: [userId(user_id)], meshadmin }, 15_000));
    },
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
      serverResult(await client.sendCommand({ action: 'removemeshuser', meshid: meshId(mesh_id), userid: userId(user_id) }, 15_000)),
  });

  define({
    name: 'mesh_add_device_user', tier: 'A', title: 'Grant device access',
    description:
      'Grant a user a direct link to one device, or remove it. Pass full_rights: true or list named rights ' +
      '(restrictions such as no_desktop combine with remote_control).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ user_id, node_id, rights, full_rights, remove }) => remove
      ? `Remove ${user_id}'s access to device ${node_id}`
      : `Grant ${user_id} ${full_rights ? 'FULL rights' : `rights [${(rights ?? []).join(', ')}]`} on device ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      user_id: z.string().describe('User ID or username'),
      rights: z.array(z.enum(DEVICE_RIGHTS)).optional().describe('Named rights to grant'),
      full_rights: z.boolean().optional().describe('Grant full control of the device (overrides rights)'),
      remove: z.boolean().optional().describe('Set true to remove the link'),
    },
    handler: async ({ node_id, user_id, rights, full_rights, remove }) => {
      if (!remove && !full_rights && !rights?.length) return errorResult('Pass rights (a list of named rights), full_rights: true, or remove: true.');
      const mask = remove ? 0 : full_rights ? DEVICE_FULL_RIGHTS : rightsMask(rights);
      return serverResult(await client.sendCommand({
        action: 'adddeviceuser', nodeid: await resolveNodeId(node_id), userids: [userId(user_id)], rights: mask, ...(remove ? { remove: true } : {}),
      }, 15_000));
    },
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
