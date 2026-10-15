import fs from 'fs';
import { z } from 'zod';
import { resolveLocalPath } from '../local-path.js';
import { textResult, deviceResult, errorResult } from '../safety.js';

// RF — remote data read
export default function register(ctx) {
  const { define, client, requireNode, resolveNodeId, isWindowsNode, runShell, runConsole, withFileTunnel } = ctx;

  // ════════════════════════════════════════════════════════════════════════
  // RF — remote data read
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_get_device_info', tier: 'RF', title: 'Device agent info',
    description: 'Live system summary from the device agent (OS, hardware, network).',
    schema: { node_id: z.string().describe('Device node ID or name (must be online)') },
    handler: async ({ node_id }) => {
      const node = await requireNode(node_id);
      const out = await runConsole(node, 'sysinfo');
      return deviceResult(out || '(no response from agent)', `Agent info for ${node.name}:`);
    },
  });

  define({
    name: 'mesh_list_software', tier: 'RF', title: 'List software',
    description:
      'Installed software on a device. Runs a read-only OS-appropriate inventory command through the agent ' +
      '(the native MeshCentral software action is broken on some server versions and is not used).',
    schema: { node_id: z.string().describe('Device node ID or name (must be online)') },
    handler: async ({ node_id }) => {
      const node = await requireNode(node_id);
      const win = isWindowsNode(node);
      const cmd = win
        ? "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, " +
          "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* " +
          "| Where-Object DisplayName | Select-Object DisplayName,DisplayVersion | Sort-Object DisplayName | Format-Table -AutoSize | Out-String"
        : "(command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Package} ${Version}\\n') || (command -v rpm >/dev/null 2>&1 && rpm -qa) || echo 'No supported package manager found'";
      const out = await runShell(node, cmd, win ? 2 : 3, 180_000);
      return deviceResult(out, `Installed software on ${node.name}:`);
    },
  });

  define({
    name: 'mesh_get_clipboard', tier: 'RF', title: 'Get clipboard',
    sensitive: true, // clipboards often hold passwords
    confirmSummary: ({ node_id }) => `Read the clipboard of ${node_id}`,
    description: 'Read the clipboard contents of a device (agent must be online; empty clipboard returns nothing).',
    schema: { node_id: z.string().describe('Device node ID or name (must be online)') },
    handler: async ({ node_id }) => {
      const id = await resolveNodeId(node_id);
      client.sendRaw({ action: 'msg', type: 'getclip', nodeid: id, tag: 3 }).catch(() => {});
      try {
        const res = await client.waitForMessage(
          (m) => m.action === 'msg' && m.type === 'getclip' && m.nodeid === id && m.data !== undefined,
          15_000
        );
        return deviceResult(res.data, 'Clipboard:');
      } catch {
        return errorResult('No clipboard data returned (clipboard empty, no desktop session, or clipboard module missing).');
      }
    },
  });

  const DOWNLOAD_DEFAULT_MB = 100;
  const DOWNLOAD_MAX_MB = 2048;

  // ── File reads (RF) ──────────────────────────────────────────────────────
  define({
    name: 'mesh_file_list', tier: 'RF', title: 'List remote files',
    description: 'List files and folders on a device.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Directory path (e.g. "C:\\\\" on Windows, "/" on Linux)'),
    },
    handler: async ({ node_id, path: dirPath }) =>
      deviceResult(await withFileTunnel(node_id, (t) => t.list(dirPath)), `Listing of ${dirPath}:`),
  });

  define({
    name: 'mesh_file_read', tier: 'RF', title: 'Read remote file',
    description: 'Read a file from a device. Text is returned inline; binary as base64.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      file_path: z.string().describe('Full path of the file to read'),
      max_kb: z.number().int().positive().optional().describe('Max size to read in KB (default 512, max 2048)'),
    },
    handler: async ({ node_id, file_path, max_kb }) => {
      const maxBytes = Math.min(max_kb ?? 512, 2048) * 1024;
      const data = await withFileTunnel(node_id, (t) => t.download(file_path, { maxBytes }));
      if (data.length === 0) return textResult('(empty file, 0 bytes)');
      const text = data.toString('utf8');
      const printable = [...text].filter((c) => c.charCodeAt(0) >= 9 && c.charCodeAt(0) !== 65533).length / text.length;
      if (printable > 0.95) return deviceResult(text, `${file_path} (${data.length} bytes):`);
      return deviceResult(data.toString('base64'), `${file_path} (BINARY, ${data.length} bytes, base64):`);
    },
  });

  define({
    name: 'mesh_file_download', tier: 'RF', title: 'Download remote file',
    description:
      'Download a file from a device to the local file directory on this MCP host. Refuses files larger than ' +
      `max_mb (default ${DOWNLOAD_DEFAULT_MB}) and will not replace an existing local file unless overwrite is true.`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      remote_path: z.string().describe('Full path of the file on the device'),
      local_path: z.string().describe('Local destination path (confined to MESH_LOCAL_FILE_ROOT)'),
      max_mb: z.number().positive().max(DOWNLOAD_MAX_MB).optional()
        .describe(`Largest file to accept, in MB (default ${DOWNLOAD_DEFAULT_MB}, max ${DOWNLOAD_MAX_MB})`),
      overwrite: z.boolean().optional().describe('Replace an existing local file (default false)'),
    },
    handler: async ({ node_id, remote_path, local_path, max_mb, overwrite }) => {
      const dest = resolveLocalPath(local_path, { mustExist: false });
      if (!overwrite && fs.existsSync(dest)) return errorResult(`${dest} already exists. Pass overwrite: true to replace it, or choose another local_path.`);
      const maxBytes = Math.floor((max_mb ?? DOWNLOAD_DEFAULT_MB) * 1024 * 1024);
      const data = await withFileTunnel(node_id, async (t) => {
        const entry = await t.stat(remote_path).catch(() => null);
        if (entry?.s > maxBytes) throw new Error(`${remote_path} is ${(entry.s / 1048576).toFixed(1)} MB, over the ${maxBytes / 1048576} MB limit (max_mb).`);
        return t.download(remote_path, { maxBytes });
      });
      fs.writeFileSync(dest, data);
      return textResult(`Downloaded ${data.length} bytes from ${remote_path} to ${dest}`);
    },
  });

  define({
    name: 'mesh_file_find', tier: 'RF', title: 'Find remote files',
    description: 'Search for files on a device by filename filter.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Directory to search in'),
      filter: z.string().describe('Filename filter (e.g. "*.log")'),
      timeout_seconds: z.number().int().positive().max(1800).optional().describe('Max seconds to search (default 120)'),
    },
    handler: async ({ node_id, path: dirPath, filter, timeout_seconds }) => {
      const { results, complete } = await withFileTunnel(node_id, (t) => t.find(dirPath, filter, (timeout_seconds ?? 120) * 1000));
      const note = complete ? '' : ` (INCOMPLETE: search still running after ${timeout_seconds ?? 120}s; narrow the path or raise timeout_seconds)`;
      return deviceResult(results, `Search results in ${dirPath} for ${filter}: ${results.length} found${note}`);
    },
  });
}
