import { z } from 'zod';
import { textResult, deviceResult } from '../safety.js';

// R / W — the MeshCentral Inventory server plugin (troymroberts/meshcentral-inventory 1.4.2.2+):
// asset records, where a machine is plugged in (observed switch/port or AP, resolved wall jack
// chain), and the documented network-port records. Calls go to the plugin over the MCP's own
// MeshCentral session, so the plugin's View/Manage permissions apply to this account.
export default function register(ctx) {
  const { define, pluginAction, getNode } = ctx;

  // Inventory asset for a MeshCentral device (by node) or an asset id.
  async function findAsset(ref) {
    if (ref.startsWith('inventoryasset/')) return (await pluginAction('inventory', 'get', { assetId: ref })).asset;
    const node = await getNode(ref);
    const list = (await pluginAction('inventory', 'list', {})).assets ?? [];
    const matches = node
      ? list.filter((a) => a.nodeid === node._id || (a.nodeids ?? []).includes(node._id))
      : list.filter((a) => String(a.name ?? '').toLowerCase() === ref.toLowerCase());
    if (matches.length === 0) throw new Error(`No inventory asset for '${ref}'${node ? ` (${node.name})` : ''}. It may not be synchronized yet, or it is a manual asset: pass its asset id.`);
    if (matches.length > 1) throw new Error(`${matches.length} inventory assets match '${ref}'; pass an asset id: ${matches.map((a) => a.id).join(', ')}`);
    return (await pluginAction('inventory', 'get', { assetId: matches[0].id })).asset;
  }

  const jackText = (j) => j
    ? [j.site && `site ${j.site}`, `jack ${j.jack}`, j.room && `(${j.room})`, j.patchPanel && `→ panel ${j.patchPanel}${j.patchPanelPort ? `/${j.patchPanelPort}` : ''}`,
       (j.switchName || j.switchMac) && `→ switch ${j.switchName || j.switchMac}${j.switchPort ? ` port ${j.switchPort}` : ''}`,
       j.status && j.status !== 'active' && `[${j.status}]`, j.ambiguous && '[ambiguous: several jacks match]'].filter(Boolean).join(' ')
    : null;

  function describeNetwork(n) {
    if (!n) return 'Network: no data.';
    const lines = [];
    const o = n.observed;
    if (o) {
      const where = o.connection === 'wireless'
        ? `AP ${o.apName || o.apMac || '?'}${o.ssid ? ` (SSID ${o.ssid})` : ''}`
        : `switch ${o.switchName || o.switchMac || '?'}${o.switchPort ? ` port ${o.switchPort}` : ''}`;
      lines.push(`Observed: ${o.connection || '?'} on ${where}${o.site ? `, site ${o.site}` : ''}; MAC ${o.mac || '?'}, IP ${o.ip || '?'}; seen ${o.seenAt || '?'} (${o.source || '?'})`);
    } else {
      lines.push('Observed: never (record one with mesh_inventory_observe after unifi find_client).');
    }
    lines.push(`Resolved jack: ${jackText(n.resolvedJack) || '(none)'}`);
    lines.push(`Documented jack: ${jackText(n.documentedJackInfo) || (n.documentedJack ? n.documentedJack : '(none)')}`);
    if (n.knownMacs?.length) lines.push(`Known MACs: ${n.knownMacs.join(', ')}`);
    for (const i of n.issues ?? []) lines.push(`ISSUE ${i.kind}: ${i.message}`);
    return lines.join('\n');
  }

  define({
    name: 'mesh_inventory_asset', tier: 'R', title: 'Inventory asset',
    description:
      'The Inventory plugin record for a device: lifecycle status, assignment, location, warranty, and where it is ' +
      'plugged in (last observed UniFi site/switch/port or AP, the resolved wall jack -> patch panel -> switch port ' +
      'chain, the documented jack, and network issues such as undocumented or moved connections). Use the observed ' +
      'site as the console/site hint for the UniFi MCP find_client. Needs the Inventory plugin (1.4.2.2+).',
    schema: { asset: z.string().describe('Device node ID or name, or an inventory asset id (inventoryasset/...)') },
    handler: async ({ asset }) => {
      const a = await findAsset(asset);
      const head = [
        `${a.name} [${a.assetKind ?? 'asset'}, ${a.status ?? '?'}] id ${a.id}`,
        a.meshName && `Group: ${a.meshName}`,
        a.identity && `Identity: ${[a.identity.manufacturer, a.identity.model, a.identity.serial && `S/N ${a.identity.serial}`].filter(Boolean).join(' ')}`,
        a.manual?.location && `Location: ${a.manual.location}`,
        a.manual?.warrantyEnd && `Warranty end: ${a.manual.warrantyEnd}`,
        a.assignment?.assignees?.length && `Assigned: ${a.assignment.assignees.map((x) => x.display || x.id).join(', ')}`,
      ].filter(Boolean).join('\n');
      return deviceResult(`${head}\n${describeNetwork(a.network)}`, 'Inventory record:');
    },
  });

  const SWITCH = z.object({ name: z.string().optional(), mac: z.string().optional(), port: z.number().int().nullable().optional() }).partial();
  const AP = z.object({ name: z.string().optional(), mac: z.string().optional(), ssid: z.string().optional() }).partial();

  define({
    name: 'mesh_inventory_observe', tier: 'W', title: 'Record where a device is plugged in',
    description:
      'Record a sighting of a device on the network in the Inventory plugin (typically one match from the UniFi MCP ' +
      'find_client): site, wired switch + port or wireless AP + SSID, MAC, IP. The plugin keeps it as the asset\'s ' +
      'last-seen connection, adds a history entry when the site/switch/port/AP changed, and resolves the wall jack. ' +
      'Older sightings than the stored one are ignored. Needs the plugin\'s Manage inventory permission for this account.',
    describe: ({ asset, site, switch: sw, access_point: ap }) =>
      `Inventory: ${asset} seen on ${sw ? `switch ${sw.name ?? sw.mac} port ${sw.port ?? '?'}` : ap ? `AP ${ap.name ?? ap.mac}` : '?'}${site ? ` (${site})` : ''}`,
    schema: {
      asset: z.string().describe('Device node ID or name, or an inventory asset id'),
      mac: z.string().optional().describe('MAC address the device was seen with'),
      ip: z.string().optional().describe('IP address'),
      site: z.string().optional().describe('UniFi console/site, e.g. "ABC-Aranguez-UDM-SE/Default"'),
      connection: z.enum(['wired', 'wireless']).optional(),
      switch: SWITCH.optional().describe('find_client switch {name, mac, port}'),
      access_point: AP.optional().describe('find_client access_point {name, mac, ssid}'),
      seen_at: z.string().optional().describe('ISO time of the sighting (default now)'),
      source: z.string().optional().describe('Default "unifi-mcp"'),
    },
    handler: async ({ asset, mac, ip, site, connection, switch: sw, access_point: ap, seen_at, source }) => {
      const a = await findAsset(asset);
      const observation = {
        mac, ip, site, connection,
        switchName: sw?.name, switchMac: sw?.mac, switchPort: sw?.port ?? undefined,
        apName: ap?.name, apMac: ap?.mac, ssid: ap?.ssid,
        seenAt: seen_at, source: source ?? 'unifi-mcp',
      };
      const r = await pluginAction('inventory', 'network-observe', { assetId: a.id, mac, observation });
      const state = r.stale ? 'ignored (older than the stored sighting)' : r.moved ? 'recorded: MOVED' : r.changed ? 'recorded: first sighting / changed' : 'recorded (no change)';
      return textResult(`${a.name}: ${state}.\n${describeNetwork(r.asset?.network)}`);
    },
  });

  define({
    name: 'mesh_inventory_netports', tier: 'R', title: 'Documented network ports',
    description:
      'Documented network ports (wall jack -> patch panel/port -> switch/port) from the Inventory plugin, optionally ' +
      'filtered by site (exact) or search text (jack, room, panel, switch). Shows duplicate switch-port claims and ' +
      'which assets were last seen on each port.',
    schema: {
      site: z.string().optional().describe('Exact site name (case-insensitive)'),
      search: z.string().optional().describe('Text to search in jack, room, patch panel, switch name/MAC, notes'),
      max_items: z.number().int().positive().max(2000).optional().describe('Max rows (default 200)'),
    },
    handler: async ({ site, search, max_items }) => {
      const r = await pluginAction('inventory', 'netport-list', { site, search });
      const ports = r.netports ?? [];
      if (ports.length === 0) return textResult(`No documented network ports${site ? ` for site ${site}` : ''}${search ? ` matching "${search}"` : ''}. Sites: ${(r.sites ?? []).join(', ') || '(none)'}`);
      const max = max_items ?? 200;
      const rows = ports.slice(0, max).map((p) => {
        const seen = (p.observedAssets ?? []).map((x) => x.name).join(', ');
        const issues = (p.issues ?? []).map((i) => i.kind).join(', ');
        return `${jackText(p)}${seen ? ` | seen: ${seen}` : ''}${issues ? ` | ISSUES: ${issues}` : ''}`;
      });
      return deviceResult(`${rows.join('\n')}${ports.length > max ? `\n... ${ports.length - max} more` : ''}`, `Network ports (${ports.length}):`);
    },
  });
}
