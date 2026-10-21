import { z } from 'zod';
import { deviceResult, errorResult, textResult } from '../safety.js';
import { agentRisk } from '../agent-guard.js';

// RF / X — installed software (the MeshCentral Software tab).
//
// MeshCentral 1.3.0+ answers the native 'software' action from the agent's own
// inventory (Windows: HKLM uninstall keys + Store apps; Linux: dpkg/rpm/apk/flatpak/snap).
// Older servers could crash on it, so they keep the shell inventory command.
export default function register(ctx) {
  const { define, requireNode, isWindowsNode, runShell, serverVersion, versionAtLeast, nativeSoftware } = ctx;

  const NATIVE_MIN = [1, 3, 0];

  async function shellInventory(node) {
    const win = isWindowsNode(node);
    const cmd = win
      ? "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, " +
        "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* " +
        "| Where-Object DisplayName | Select-Object DisplayName,DisplayVersion | Sort-Object DisplayName | Format-Table -AutoSize | Out-String"
      : "(command -v dpkg-query >/dev/null 2>&1 && dpkg-query -W -f='${Package} ${Version}\\n') || (command -v rpm >/dev/null 2>&1 && rpm -qa) || echo 'No supported package manager found'";
    return runShell(node, cmd, win ? 2 : 3, 180_000);
  }

  const fmtDate = (d) => (/^\d{8}$/.test(d ?? '') ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d || '');

  function formatApps(apps, filter) {
    const f = filter?.toLowerCase();
    const rows = apps
      .filter((a) => a && a.name && (!f || `${a.name} ${a.publisher ?? ''}`.toLowerCase().includes(f)))
      .sort((a, b) => a.name.localeCompare(b.name));
    const lines = rows.map((a) =>
      [a.name, a.version || '-', a.publisher || '-', fmtDate(a.date) || '-', a.arch || a.location || ''].join(' | ').replace(/\s*\|\s*$/, '')
    );
    return { count: rows.length, text: `name | version | publisher | installed | arch/source\n${lines.join('\n') || '(none)'}` };
  }

  define({
    name: 'mesh_list_software', tier: 'RF', title: 'List software',
    description:
      'Installed software on a device, as on the MeshCentral Software tab: name, version, publisher, install date. ' +
      'Windows lists machine-wide programs (HKLM; per-user installs are not included); store_apps lists Microsoft ' +
      'Store/AppX packages instead. Linux lists dpkg/rpm/apk/flatpak/snap packages. Needs MeshCentral 1.3.0+ for ' +
      'the native inventory; older servers fall back to a read-only inventory command.',
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      filter: z.string().optional().describe('Only entries whose name or publisher contains this (case-insensitive)'),
      store_apps: z.boolean().optional().describe('Windows only: list Store/AppX apps instead of installed programs'),
    },
    handler: async ({ node_id, filter, store_apps }) => {
      const node = await requireNode(node_id);
      if (store_apps && !isWindowsNode(node)) return errorResult('store_apps is only available on Windows devices.');
      let fallbackReason = null;
      if (versionAtLeast(await serverVersion(), NATIVE_MIN)) {
        try {
          const apps = await nativeSoftware(node._id, store_apps ? 'installedstoreapps' : 'installedapps');
          if (Array.isArray(apps)) {
            const { count, text } = formatApps(apps, filter);
            return deviceResult(text, `${store_apps ? 'Store apps' : 'Installed software'} on ${node.name} (${count}${filter ? ` matching "${filter}"` : ''}):`);
          }
          fallbackReason = 'unexpected reply from the agent';
        } catch (err) {
          fallbackReason = err.message;
        }
      } else {
        fallbackReason = 'MeshCentral server older than 1.3.0';
      }
      if (store_apps) return errorResult(`Store apps need the native inventory (${fallbackReason}).`);
      let out = await shellInventory(node);
      if (filter) out = out.split('\n').filter((l, i) => i < 3 || l.toLowerCase().includes(filter.toLowerCase())).join('\n');
      return deviceResult(out, `Installed software on ${node.name} (inventory command; native inventory unavailable: ${fallbackReason}):`);
    },
  });

  define({
    name: 'mesh_uninstall_software', tier: 'X', title: 'Uninstall software', explain: true, sensitive: true,
    description:
      'Uninstall a Windows program through the MeshCentral Software tab action: looks the program up by exact name ' +
      '(see mesh_list_software) and runs its registered uninstall command (msiexec or .exe) silently where possible. ' +
      'Windows only; Store apps are not supported. Needs MeshCentral 1.3.0+.',
    agentRisk: ({ name }) => agentRisk(`uninstall ${name}`),
    confirmSummary: ({ node_id, name }) => `Uninstall "${name}" from ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online, Windows)'),
      name: z.string().min(1).describe('Exact program name as shown by mesh_list_software'),
      timeout_seconds: z.number().int().positive().max(1800).optional().describe('How long to wait for the uninstaller (default 300)'),
    },
    handler: async ({ node_id, name, timeout_seconds }) => {
      const node = await requireNode(node_id);
      if (!isWindowsNode(node)) return errorResult(`${node.name} is not a Windows device; uninstall is Windows-only.`);
      if (!versionAtLeast(await serverVersion(), NATIVE_MIN)) return errorResult('Uninstall needs MeshCentral 1.3.0 or newer.');
      const apps = await nativeSoftware(node._id, 'installedapps');
      const matches = (Array.isArray(apps) ? apps : []).filter((a) => a?.name === name);
      if (matches.length === 0) return errorResult(`No installed program named exactly "${name}" on ${node.name}. Check the name with mesh_list_software.`);
      if (matches.length > 1) return errorResult(`${matches.length} programs are named "${name}" on ${node.name}; uninstall them from the MeshCentral Software tab.`);
      const app = matches[0];
      if (!app.uninstall) return errorResult(`"${name}" has no registered uninstall command.`);
      const reply = await nativeSoftware(node._id, 'uninstallapp', Buffer.from(app.uninstall).toString('base64'),
        (timeout_seconds ?? 300) * 1000, (d) => d && typeof d === 'object' && 'success' in d);
      if (reply && reply.success === false) return errorResult(`Uninstall of "${name}" failed: ${reply.error ?? 'unknown error'}`);
      const code = reply?.exitCode != null ? `exit code ${reply.exitCode}${reply.exitCode === 3010 ? ' (reboot required)' : ''}` : 'no exit code';
      return textResult(`Uninstalled "${name}"${app.version ? ` (${app.version})` : ''} on ${node.name} (${code}). Verify with mesh_list_software.`);
    },
  });
}
