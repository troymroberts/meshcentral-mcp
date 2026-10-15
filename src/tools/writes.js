import { z } from 'zod';
import { joinRemotePath, isWindowsPath } from '../file-tunnel.js';
import { agentPathRisk } from '../agent-guard.js';
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
    description: "Edit a device's name, host, tags, or RDP/SSH ports. (Consent flags: mesh_set_device_consent.)",
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      name: z.string().optional().describe('New display name'),
      host: z.string().optional().describe('New hostname/IP'),
      tags: z.array(z.string().min(1).max(63).regex(/^[^,]+$/, 'tags cannot contain commas')).optional()
        .describe('Tags to set (replaces all existing tags; [] clears them)'),
      rdpport: z.number().int().optional().describe('RDP port'),
      sshport: z.number().int().optional().describe('SSH port'),
    },
    handler: async ({ node_id, ...props }) => {
      const cmd = { action: 'changedevice', nodeid: await resolveNodeId(node_id), ...props };
      // MeshCentral takes an array of tags; the empty string clears them.
      if (Array.isArray(cmd.tags) && !cmd.tags.length) cmd.tags = '';
      return serverResult(await client.sendCommand(cmd, 15_000));
    },
  });

  define({
    name: 'mesh_set_device_consent', tier: 'A', title: 'Set device consent',
    description:
      "Set a device's user-consent flags: whether the person at the device is notified of, or must approve, " +
      'desktop, terminal and file sessions. Lowering them removes a privacy control. ' +
      'Bits: 1 desktop notify, 2 terminal notify, 4 files notify, 8 desktop prompt, 16 terminal prompt, ' +
      '32 files prompt, 64 connection toolbar. 0 = no notification or prompt.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, consent }) => `Set consent flags on ${node_id} to ${consent}`,
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      consent: z.number().int().min(0).describe('Consent flags bitmask (see description)'),
    },
    handler: async ({ node_id, consent }) =>
      serverResult(await client.sendCommand({ action: 'changedevice', nodeid: await resolveNodeId(node_id), consent }, 15_000)),
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
    name: 'mesh_change_device_group', tier: 'A', title: 'Move device to group',
    description: 'Move a device to a different device group. This changes which users can access it.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, meshid }) => `Move ${node_id} to group ${meshid} (changes who can access it)`,
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
      title: z.string().max(128).optional().describe('Notification title (default "MeshCentral")'),
    },
    handler: async ({ node_ids, message, title }) =>
      serverResult(await client.sendCommand({ action: 'toast', nodeids: await resolveNodeIds(node_ids), title: title || 'MeshCentral', msg: message }, 15_000)),
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
    name: 'mesh_create_invite_link', tier: 'A', title: 'Create invite link',
    description: 'Create an agent-installation invite link for a device group. Anyone with the link can enrol a device into the group until it expires.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ mesh_id, expire_hours }) => `Create an invite link for group ${mesh_id}, valid ${expire_hours ?? 8}h`,
    schema: {
      mesh_id: z.string().describe('Device group ID or name'),
      expire_hours: z.number().int().positive().optional().describe('Expiry in hours (default 8)'),
      flags: z.number().int().optional().describe('Invite flags (0 = installation link)'),
    },
    handler: async ({ mesh_id, expire_hours, flags }) =>
      serverResult(await client.sendCommand({ action: 'createInviteLink', meshid: meshId(mesh_id), expire: expire_hours ?? 8, flags: flags ?? 0 }, 15_000)),
  });

  // ── Remote file operations ─────────────────────────────────────────────────
  // mkdir is W; rename/copy/move can overwrite or displace files, so they are WF.
  // These agent file ops are not acknowledged, so each verifies via stat()/list().
  // The agent does not acknowledge copy/move: poll the destination (and, for a
  // move, the source) until every name has arrived/left, or give up.
  async function verifyTransfer(t, verb, sourceDir, destDir, names, { maxMs = 10_000 } = {}) {
    const fold = (n) => (isWindowsPath(destDir) ? n.toLowerCase() : n);
    const deadline = Date.now() + maxMs;
    let missing = names;
    let left = [];
    do {
      await new Promise((r) => setTimeout(r, 500));
      const dest = await t.list(destDir).then((d) => new Set(d.map((e) => fold(e.n)))).catch(() => null);
      if (!dest) return errorResult(`${verb} requested, but ${destDir} could not be listed to confirm it.`);
      missing = names.filter((n) => !dest.has(fold(n)));
      if (verb === 'move' && !missing.length) {
        const src = await t.list(sourceDir).then((d) => new Set(d.map((e) => fold(e.n)))).catch(() => new Set());
        left = names.filter((n) => src.has(fold(n)));
      }
      if (!missing.length && !left.length) {
        return textResult(`${verb === 'move' ? 'Moved' : 'Copied'} ${JSON.stringify(names)} from ${sourceDir} to ${destDir}`);
      }
    } while (Date.now() < deadline);
    if (missing.length) return errorResult(`${verb} requested, but not in ${destDir} after ${maxMs / 1000}s: ${JSON.stringify(missing)}`);
    return errorResult(`move requested; copied to ${destDir} but still present in ${sourceDir}: ${JSON.stringify(left)}`);
  }

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
    name: 'mesh_file_rename', tier: 'WF', title: 'Rename remote file',
    description: 'Rename a file or folder on a device (within its directory).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, path, old_name, new_name }) => `Rename ${old_name} to ${new_name} in ${path} on ${node_id}`,
    agentRisk: async ({ path, old_name, new_name }) => agentPathRisk(path, old_name, new_name),
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
    name: 'mesh_file_copy', tier: 'WF', title: 'Copy remote files',
    description: 'Copy files between directories on a device (existing files in dest_dir may be overwritten).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, source_dir, dest_dir, names }) =>
      `Copy ${JSON.stringify(names)} from ${source_dir} to ${dest_dir} on ${node_id}`,
    agentRisk: async ({ source_dir, dest_dir, names }) => agentPathRisk(source_dir, dest_dir, names),
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      source_dir: z.string().describe('Source directory'),
      dest_dir: z.string().describe('Destination directory'),
      names: z.array(z.string()).describe('File names to copy (relative to source_dir)'),
    },
    handler: async ({ node_id, source_dir, dest_dir, names }) =>
      withFileTunnel(node_id, async (t) => {
        t.copy(source_dir, dest_dir, names);
        return verifyTransfer(t, 'copy', source_dir, dest_dir, names);
      }),
  });

  define({
    name: 'mesh_file_move', tier: 'WF', title: 'Move remote files',
    description: 'Move files between directories on a device (existing files in dest_dir may be overwritten).',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, source_dir, dest_dir, names }) =>
      `Move ${JSON.stringify(names)} from ${source_dir} to ${dest_dir} on ${node_id}`,
    agentRisk: async ({ source_dir, dest_dir, names }) => agentPathRisk(source_dir, dest_dir, names),
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      source_dir: z.string().describe('Source directory'),
      dest_dir: z.string().describe('Destination directory'),
      names: z.array(z.string()).describe('File names to move (relative to source_dir)'),
    },
    handler: async ({ node_id, source_dir, dest_dir, names }) =>
      withFileTunnel(node_id, async (t) => {
        t.move(source_dir, dest_dir, names);
        return verifyTransfer(t, 'move', source_dir, dest_dir, names);
      }),
  });
}
