import fs from 'fs';
import { z } from 'zod';
import { resolveLocalPath } from '../local-path.js';
import { textResult, deviceResult, errorResult } from '../safety.js';
import { agentPathRisk } from '../agent-guard.js';
import { parseRegistryPath, joinRegistryPath, VALUE_TYPES } from '../registry-tunnel.js';

// RF / WF — Windows registry through MeshCentral's remote registry relay (the
// Registry tab; MeshCentral 1.3.0+). Reads are RF, changes are WF.
export default function register(ctx) {
  const { define, requireNode, isWindowsNode, withRegistryTunnel } = ctx;

  const KEY_SCHEMA = z.string().describe('Registry key, e.g. HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion (HKLM, HKCU, HKU, HKCR, HKCC or full HKEY_ names)');
  const VALUE_PREVIEW = 300;

  async function windowsNode(node_id) {
    const node = await requireNode(node_id);
    if (!isWindowsNode(node)) throw new Error(`${node.name} is not a Windows device; remote registry is Windows-only.`);
    return node;
  }

  // Writes refuse a hive or a key directly under it (HKLM\SOFTWARE, HKLM\SYSTEM ...):
  // one mistake there breaks the machine, and MeshCentral itself refuses hive deletes.
  function writableKey(full, what) {
    const { hive, path } = parseRegistryPath(full);
    if (path.split('\\').length < 2) throw new Error(`Refusing to ${what} ${joinRegistryPath(hive, path)}: too close to the hive root. Target a deeper key.`);
    return { hive, path };
  }

  const splitLast = (path) => {
    const i = path.lastIndexOf('\\');
    return i < 0 ? { parent: '', name: path } : { parent: path.slice(0, i), name: path.slice(i + 1) };
  };

  const fmtValue = (v) => {
    const text = String(v.value ?? '');
    return `${v.name} | ${v.type} | ${text.length > VALUE_PREVIEW ? `${text.slice(0, VALUE_PREVIEW)}... (${text.length} chars)` : text}`;
  };

  // ── reads (RF) ─────────────────────────────────────────────────────────
  define({
    name: 'mesh_registry_list', tier: 'RF', title: 'List registry key',
    description:
      'List the subkeys and values of a Windows registry key on a device (the MeshCentral Registry tab; needs ' +
      'MeshCentral 1.3.0+ and remote-control rights). Omit key to list the hives. The agent looks up each value ' +
      'type separately, so keys with hundreds of values are slow; narrow with filter.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online, Windows)'),
      key: KEY_SCHEMA.optional(),
      filter: z.string().optional().describe('Only subkeys/values whose name contains this (case-insensitive)'),
      max_items: z.number().int().positive().max(2000).optional().describe('Max subkeys and values each (default 200)'),
    },
    handler: async ({ node_id, key, filter, max_items }) => {
      const node = await windowsNode(node_id);
      if (!key) {
        const roots = await withRegistryTunnel(node._id, (t) => t.roots());
        return textResult(`Registry hives on ${node.name}:\n${roots.join('\n')}`);
      }
      const { hive, path } = parseRegistryPath(key);
      const { subkeys, values } = await withRegistryTunnel(node._id, (t) => t.list(hive, path));
      const max = max_items ?? 200;
      const f = filter?.toLowerCase();
      const keep = (name) => !f || String(name).toLowerCase().includes(f);
      const sk = subkeys.filter(keep), vals = values.filter((v) => keep(v.name));
      const more = (n, total) => (total > n ? `\n... ${total - n} more (raise max_items or use filter)` : '');
      const body =
        `Subkeys (${sk.length}):\n${sk.slice(0, max).join('\n') || '(none)'}${more(max, sk.length)}\n\n` +
        `Values (${vals.length}) - name | type | data:\n${vals.slice(0, max).map(fmtValue).join('\n') || '(none)'}${more(max, vals.length)}`;
      return deviceResult(body, `${joinRegistryPath(hive, path)} on ${node.name}:`);
    },
  });

  define({
    name: 'mesh_registry_export', tier: 'RF', title: 'Export registry key',
    description:
      'Export a Windows registry key (with all subkeys) as .reg text, returned inline or saved to local_path on ' +
      'this MCP host. Exports of large keys (e.g. HKLM\\SOFTWARE) are tens of MB; prefer a specific key.',
    sensitive: ({ key }) => /\\(SAM|SECURITY)(\\|$)/i.test(String(key ?? '')),
    confirmSummary: ({ node_id, key }) => `Export registry key ${key} from ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online, Windows)'),
      key: KEY_SCHEMA,
      local_path: z.string().optional().describe('Save the .reg file here (confined to MESH_LOCAL_FILE_ROOT) instead of returning it'),
      overwrite: z.boolean().optional().describe('Replace an existing local file (default false)'),
      max_chars: z.number().int().positive().max(500_000).optional().describe('Inline result size limit (default 50000)'),
    },
    handler: async ({ node_id, key, local_path, overwrite, max_chars }) => {
      const node = await windowsNode(node_id);
      const { hive, path } = parseRegistryPath(key);
      if (!path) return errorResult('Export a key, not a whole hive.');
      const dest = local_path ? resolveLocalPath(local_path, { mustExist: false }) : null;
      if (dest && !overwrite && fs.existsSync(dest)) return errorResult(`${dest} already exists. Pass overwrite: true to replace it, or choose another local_path.`);
      const content = await withRegistryTunnel(node._id, (t) => t.export(hive, path));
      if (dest) {
        fs.writeFileSync(dest, '﻿' + content, 'utf16le'); // .reg files are UTF-16LE with a BOM
        return textResult(`Exported ${joinRegistryPath(hive, path)} from ${node.name} to ${dest} (${content.length} chars).`);
      }
      const max = max_chars ?? 50_000;
      const text = content.length > max ? `${content.slice(0, max)}\n... truncated (${content.length} chars; use local_path)` : content;
      return deviceResult(text, `${joinRegistryPath(hive, path)} exported from ${node.name}:`);
    },
  });

  // ── changes (WF) ───────────────────────────────────────────────────────
  define({
    name: 'mesh_registry_set_value', tier: 'WF', title: 'Set registry value', explain: true,
    description:
      'Create or overwrite a registry value on a Windows device. The key is created if missing. REG_DWORD/QWORD data ' +
      'is decimal or 0x-hex; REG_MULTI_SZ entries are separated with \\0. Refuses keys directly under a hive.',
    agentRisk: ({ key, name }) => agentPathRisk(key, name),
    confirmSummary: ({ node_id, key, name, type, data }) => `Set ${key}\\${name || '(Default)'} = ${type} "${String(data).slice(0, 120)}" on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online, Windows)'),
      key: KEY_SCHEMA,
      name: z.string().describe('Value name ("" for the key\'s default value)'),
      type: z.enum(VALUE_TYPES).describe('Value type'),
      data: z.string().describe('Value data as text'),
    },
    handler: async ({ node_id, key, name, type, data }) => {
      const node = await windowsNode(node_id);
      const { hive, path } = writableKey(key, 'write under');
      await withRegistryTunnel(node._id, (t) => t.setValue(hive, path, name, type, data));
      return textResult(`Set ${joinRegistryPath(hive, path)}\\${name || '(Default)'} (${type}) on ${node.name}.`);
    },
  });

  define({
    name: 'mesh_registry_create_key', tier: 'WF', title: 'Create registry key', explain: true,
    description: 'Create a subkey under an existing registry key on a Windows device.',
    agentRisk: ({ key, name }) => agentPathRisk(key, name),
    confirmSummary: ({ node_id, key, name }) => `Create registry key ${key}\\${name} on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online, Windows)'),
      key: KEY_SCHEMA.describe('Parent key'),
      name: z.string().min(1).describe('New subkey name (no backslashes)'),
    },
    handler: async ({ node_id, key, name }) => {
      const node = await windowsNode(node_id);
      const { hive, path } = parseRegistryPath(key);
      if (!path) return errorResult('Refusing to create a key directly under a hive.');
      await withRegistryTunnel(node._id, (t) => t.createKey(hive, path, name));
      return textResult(`Created ${joinRegistryPath(hive, path)}\\${name} on ${node.name}.`);
    },
  });

  define({
    name: 'mesh_registry_delete', tier: 'WF', title: 'Delete registry key or value', explain: true, sensitive: true,
    description:
      'Delete a registry value (when value_name is given) or a whole key with all its subkeys (when it is not) on a ' +
      'Windows device. Export the key first if it may be needed again. Refuses keys directly under a hive.',
    agentRisk: ({ key, value_name }) => agentPathRisk(key, value_name),
    confirmSummary: ({ node_id, key, value_name }) =>
      value_name != null ? `Delete registry value ${key}\\${value_name || '(Default)'} on ${node_id}` : `Delete registry KEY ${key} and everything under it on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online, Windows)'),
      key: KEY_SCHEMA,
      value_name: z.string().optional().describe('Value to delete ("" = default value). Omit to delete the key itself'),
    },
    handler: async ({ node_id, key, value_name }) => {
      const node = await windowsNode(node_id);
      const { hive, path } = writableKey(key, 'delete');
      const item = value_name != null
        ? { kind: 'value', hive, path, name: value_name }
        : { kind: 'key', hive, path: splitLast(path).parent, name: splitLast(path).name };
      await withRegistryTunnel(node._id, (t) => t.delete([item]));
      return textResult(value_name != null
        ? `Deleted value ${joinRegistryPath(hive, path)}\\${value_name || '(Default)'} on ${node.name}.`
        : `Deleted key ${joinRegistryPath(hive, path)} on ${node.name}.`);
    },
  });

  define({
    name: 'mesh_registry_rename', tier: 'WF', title: 'Rename registry key or value', explain: true,
    description: 'Rename a registry value (when value_name is given) or a key (copy + delete, when it is not) on a Windows device.',
    agentRisk: ({ key, value_name, new_name }) => agentPathRisk(key, value_name, new_name),
    confirmSummary: ({ node_id, key, value_name, new_name }) =>
      `Rename ${value_name != null ? `value ${key}\\${value_name}` : `key ${key}`} to "${new_name}" on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online, Windows)'),
      key: KEY_SCHEMA,
      value_name: z.string().min(1).optional().describe('Value to rename. Omit to rename the key itself'),
      new_name: z.string().min(1).describe('New name (no backslashes)'),
    },
    handler: async ({ node_id, key, value_name, new_name }) => {
      const node = await windowsNode(node_id);
      const { hive, path } = writableKey(key, 'rename');
      const item = value_name != null
        ? { kind: 'value', hive, path, name: value_name }
        : { kind: 'key', hive, path: splitLast(path).parent, name: splitLast(path).name };
      await withRegistryTunnel(node._id, (t) => t.rename(item, new_name));
      return textResult(`Renamed ${value_name != null ? `value ${value_name} in ${joinRegistryPath(hive, path)}` : `key ${joinRegistryPath(hive, path)}`} to "${new_name}" on ${node.name}.`);
    },
  });
}
