import { z } from 'zod';
import { joinRemotePath } from '../file-tunnel.js';
import { textResult, serverResult, errorResult } from '../safety.js';

// W — low-impact writes
export default function register(ctx) {
  const { define, client, audit, meshId, resolveNodeId, resolveNodeIds, withFileTunnel } = ctx;

  // ════════════════════════════════════════════════════════════════════════
  // W — low-impact writes
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_set_notes', tier: 'W', title: 'Device notes',
    description:
      "Update a device's notes (the free-text Notes field in MeshCentral). Default mode \"append\" adds a " +
      'timestamped line and keeps existing notes; "replace" overwrites them (use only when asked). For a record of ' +
      'what was diagnosed or done, prefer mesh_log_event (it goes in the device history).',
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      notes: z.string().describe('Text to add (append) or the full new notes (replace)'),
      mode: z.enum(['append', 'replace']).optional().describe('Default "append"'),
    },
    describe: async ({ notes, mode }) => `${mode === 'replace' ? 'Replace' : 'Append to'} device notes: ${notes.slice(0, 200)}`,
    handler: async ({ node_id, notes, mode }) => {
      const id = await resolveNodeId(node_id);
      let text = notes;
      if (mode !== 'replace') {
        const current = await client.sendCommand({ action: 'getNotes', id }, 10_000).then((r) => r?.notes ?? '').catch(() => null);
        if (current == null) return errorResult('Could not read the current notes, so nothing was changed (use mode "replace" to overwrite).');
        const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
        text = `${current ? current.replace(/\s+$/, '') + '\n' : ''}[${stamp} UTC] ${notes}`;
      }
      await client.sendRaw({ action: 'setNotes', id, notes: text });
      const check = await client.sendCommand({ action: 'getNotes', id }, 10_000).then((r) => r?.notes ?? '').catch(() => null);
      if (check !== text) return errorResult('Notes update sent but could not be confirmed (no SETNOTES right on this device?).');
      return textResult(mode === 'replace' ? 'Notes replaced.' : `Note appended. Device notes now:\n${text}`);
    },
  });

  define({
    name: 'mesh_log_event', tier: 'W', title: 'Record device event',
    description:
      "Add an entry to a device's MeshCentral event log (its Events tab), attributed to this account and prefixed " +
      '"[MCP note]". Use it at the end of a diagnostic or service session to record what was found, what was ' +
      'changed, and what is still open, so the next session (human or AI) can read it with mesh_device_history. ' +
      'Keep it factual and concise (max ~3000 characters).',
    schema: {
      node_ids: z.array(z.string()).min(1).describe('Device(s) the entry applies to'),
      message: z.string().min(1).max(3400).describe('What was found / done / left open'),
    },
    change: () => false, // the call itself is the event; do not echo it
    describe: async ({ message }) => `Record event: ${message.slice(0, 200)}`,
    handler: async ({ node_ids, message }) => {
      const ids = await resolveNodeIds(node_ids);
      for (const id of ids) await audit.deviceEvent(id, `[MCP note] ${message}`);
      return textResult(`Recorded on ${ids.length} device(s). It appears in their MeshCentral Events tab and in mesh_device_history (filter "manual").`);
    },
  });

  define({
    name: 'mesh_edit_device', tier: 'W', title: 'Edit device',
    description: "Edit a device's name, host, tags, consent flags, or RDP/SSH ports.",
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      name: z.string().optional().describe('New display name'),
      host: z.string().optional().describe('New hostname/IP'),
      tags: z.array(z.string()).optional().describe('Tags to set'),
      consent: z.number().int().optional().describe('Consent flags bitmask'),
      rdpport: z.number().int().optional().describe('RDP port'),
      sshport: z.number().int().optional().describe('SSH port'),
    },
    handler: async ({ node_id, ...props }) => {
      const cmd = { action: 'changedevice', nodeid: await resolveNodeId(node_id), ...props };
      if (Array.isArray(cmd.tags)) cmd.tags = JSON.stringify(cmd.tags);
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_create_group', tier: 'W', title: 'Create device group',
    description: 'Create a new device group.',
    schema: {
      name: z.string().describe('Name of the new device group'),
      description: z.string().optional().describe('Optional description'),
      type: z.number().int().optional().describe('1=AMT, 2=Agent (default), 3=Local'),
    },
    handler: async ({ name, description, type }) => {
      const cmd = { action: 'createmesh', meshname: name, meshtype: type ?? 2 };
      if (description) cmd.desc = description;
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_edit_group', tier: 'W', title: 'Edit device group',
    description: 'Edit a device group name or description.',
    schema: {
      mesh_id: z.string().describe('Device group ID or name'),
      name: z.string().optional().describe('New group name'),
      description: z.string().optional().describe('New description'),
    },
    handler: async ({ mesh_id, name, description }) => {
      const cmd = { action: 'editmesh', meshid: meshId(mesh_id) };
      if (name) cmd.meshname = name;
      if (description !== undefined) cmd.desc = description;
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_change_device_group', tier: 'W', title: 'Move device to group',
    description: 'Move a device to a different device group.',
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      meshid: z.string().describe('Target group ID or name'),
    },
    handler: async ({ node_id, meshid }) =>
      serverResult(await client.sendCommand({ action: 'changeDeviceMesh', nodeids: [await resolveNodeId(node_id)], meshid: meshId(meshid) }, 15_000)),
  });

  define({
    name: 'mesh_send_toast', tier: 'W', title: 'Send toast',
    description: 'Send a toast notification to devices.',
    schema: {
      node_ids: z.array(z.string()).describe('Device node IDs or names'),
      message: z.string().describe('Notification message'),
    },
    handler: async ({ node_ids, message }) =>
      serverResult(await client.sendCommand({ action: 'toast', nodeids: await resolveNodeIds(node_ids), msg: message }, 15_000)),
  });

  define({
    name: 'mesh_wake_devices', tier: 'W', title: 'Wake devices',
    description: 'Send Wake-on-LAN to devices.',
    schema: { node_ids: z.array(z.string()).describe('Device node IDs or names to wake') },
    handler: async ({ node_ids }) =>
      serverResult(await client.sendCommand({ action: 'wakedevices', nodeids: await resolveNodeIds(node_ids) }, 15_000)),
  });

  define({
    name: 'mesh_set_clipboard', tier: 'W', title: 'Set clipboard',
    description: 'Set the clipboard contents on a device (agent must be online).',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      data: z.string().describe('Text to place on the clipboard'),
    },
    handler: async ({ node_id, data }) => {
      const id = await resolveNodeId(node_id);
      try {
        const res = await client.collectMessages(
          (m) => m.action === 'msg' && m.type === 'setclip' && m.success !== undefined,
          () => client.sendRaw({ action: 'msg', type: 'setclip', nodeid: id, data }),
          { idleMs: 200, firstMs: 10_000, maxMs: 11_000 }
        );
        if (res.length && res[0].success) return textResult('Clipboard set.');
        return textResult('Clipboard set request sent (device did not confirm; it may lack a desktop session).');
      } catch {
        return textResult('Clipboard set request sent (no confirmation from device).');
      }
    },
  });

  define({
    name: 'mesh_create_invite_link', tier: 'W', title: 'Create invite link',
    description: 'Create an agent-installation invite link for a device group.',
    schema: {
      mesh_id: z.string().describe('Device group ID or name'),
      expire_hours: z.number().int().positive().optional().describe('Expiry in hours (default 8)'),
      flags: z.number().int().optional().describe('Invite flags (0 = installation link)'),
    },
    handler: async ({ mesh_id, expire_hours, flags }) =>
      serverResult(await client.sendCommand({ action: 'createInviteLink', meshid: meshId(mesh_id), expire: expire_hours ?? 8, flags: flags ?? 0 }, 15_000)),
  });

  // ── File metadata writes (W) ─────────────────────────────────────────────
  // These agent file ops are not acknowledged, so each verifies via stat()/list().
  define({
    name: 'mesh_file_mkdir', tier: 'W', title: 'Create remote directory',
    description: 'Create a directory on a device.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Full path of the directory to create'),
    },
    handler: async ({ node_id, path: dirPath }) =>
      withFileTunnel(node_id, async (t) => {
        t.mkdir(dirPath);
        await new Promise((r) => setTimeout(r, 400));
        const entry = await t.stat(dirPath).catch(() => null);
        return entry ? textResult(`Created directory ${dirPath}`) : errorResult(`Could not confirm directory ${dirPath} was created`);
      }),
  });

  define({
    name: 'mesh_file_rename', tier: 'W', title: 'Rename remote file',
    description: 'Rename a file or folder on a device (within its directory).',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Parent directory'),
      old_name: z.string().describe('Current name'),
      new_name: z.string().describe('New name'),
    },
    handler: async ({ node_id, path: dirPath, old_name, new_name }) =>
      withFileTunnel(node_id, async (t) => {
        t.rename(dirPath, old_name, new_name);
        await new Promise((r) => setTimeout(r, 400));
        const entry = await t.stat(joinRemotePath(dirPath, new_name)).catch(() => null);
        return entry ? textResult(`Renamed ${old_name} to ${new_name} in ${dirPath}`) : errorResult(`Could not confirm rename to ${new_name}`);
      }),
  });

  define({
    name: 'mesh_file_copy', tier: 'W', title: 'Copy remote files',
    description: 'Copy files between directories on a device.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      source_dir: z.string().describe('Source directory'),
      dest_dir: z.string().describe('Destination directory'),
      names: z.array(z.string()).describe('File names to copy (relative to source_dir)'),
    },
    handler: async ({ node_id, source_dir, dest_dir, names }) =>
      withFileTunnel(node_id, async (t) => {
        t.copy(source_dir, dest_dir, names);
        await new Promise((r) => setTimeout(r, 500));
        return textResult(`Copy of ${JSON.stringify(names)} from ${source_dir} to ${dest_dir} requested (verify with mesh_file_list).`);
      }),
  });

  define({
    name: 'mesh_file_move', tier: 'W', title: 'Move remote files',
    description: 'Move files between directories on a device.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      source_dir: z.string().describe('Source directory'),
      dest_dir: z.string().describe('Destination directory'),
      names: z.array(z.string()).describe('File names to move (relative to source_dir)'),
    },
    handler: async ({ node_id, source_dir, dest_dir, names }) =>
      withFileTunnel(node_id, async (t) => {
        t.move(source_dir, dest_dir, names);
        await new Promise((r) => setTimeout(r, 500));
        return textResult(`Move of ${JSON.stringify(names)} from ${source_dir} to ${dest_dir} requested (verify with mesh_file_list).`);
      }),
  });
}
