import fs from 'fs';
import { z } from 'zod';
import { resolveLocalPath } from '../local-path.js';
import { splitRemotePath, joinRemotePath } from '../file-tunnel.js';
import { textResult, errorResult } from '../safety.js';

// WF — remote file write
export default function register(ctx) {
  const { define, withFileTunnel } = ctx;

  // ════════════════════════════════════════════════════════════════════════
  // WF — remote file write / destruction
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_file_write', tier: 'WF', title: 'Write remote file',
    description: 'Write text or base64 content to a file on a device.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, file_path }) => `Write file ${file_path} on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      file_path: z.string().describe('Full destination path on the device'),
      content: z.string().describe('Content to write'),
      encoding: z.enum(['utf8', 'base64']).optional().describe('Content encoding (default utf8)'),
    },
    handler: async ({ node_id, file_path, content, encoding }) => {
      const data = Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');
      const { dir, name } = splitRemotePath(file_path);
      await withFileTunnel(node_id, (t) => t.upload(dir, name, data));
      return textResult(`Wrote ${data.length} bytes to ${file_path}`);
    },
  });

  define({
    name: 'mesh_file_upload', tier: 'WF', title: 'Upload file to device',
    description: 'Upload a local file (from MESH_LOCAL_FILE_ROOT) to a device.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ local_path, node_id, remote_dir }) => `Upload ${local_path} to ${remote_dir} on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      local_path: z.string().describe('Local file to upload (confined to MESH_LOCAL_FILE_ROOT)'),
      remote_dir: z.string().describe('Destination directory on the device'),
      remote_name: z.string().optional().describe('Destination filename (default: same as local)'),
    },
    handler: async ({ node_id, local_path, remote_dir, remote_name }) => {
      const src = resolveLocalPath(local_path, { mustExist: true });
      const data = fs.readFileSync(src);
      const name = remote_name || splitRemotePath(src).name;
      await withFileTunnel(node_id, (t) => t.upload(remote_dir, name, data));
      return textResult(`Uploaded ${src} (${data.length} bytes) to ${joinRemotePath(remote_dir, name)}`);
    },
  });

  define({
    name: 'mesh_file_delete', tier: 'WF', title: 'Delete remote files',
    description: 'Delete files or folders on a device.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, path, names, recursive }) =>
      `Delete ${JSON.stringify(names)} from ${path} on ${node_id}${recursive ? ' (recursive)' : ''}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      path: z.string().describe('Parent directory containing the files'),
      names: z.array(z.string()).describe('File/folder names to delete (relative to path)'),
      recursive: z.boolean().optional().describe('Recursive delete for folders (default false)'),
    },
    handler: async ({ node_id, path: dirPath, names, recursive }) =>
      withFileTunnel(node_id, async (t) => {
        t.delete(dirPath, names, recursive ?? false);
        await new Promise((r) => setTimeout(r, 500));
        const remaining = await t.list(dirPath).then((d) => d.map((e) => e.n)).catch(() => null);
        if (remaining) {
          const left = names.filter((n) => remaining.includes(n));
          if (left.length) return errorResult(`Delete requested, but still present: ${JSON.stringify(left)}`);
        }
        return textResult(`Deleted ${JSON.stringify(names)} from ${dirPath}`);
      }),
  });
}
