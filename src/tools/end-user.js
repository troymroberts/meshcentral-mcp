import { z } from 'zod';
import { textResult, serverResult, errorResult, isServerError } from '../safety.js';

// Reaching the person at the device: message boxes, opening a URL, and device
// share links (guest access to one device without a MeshCentral account).
export default function register(ctx) {
  const { define, client, requireNode, resolveNodeId } = ctx;

  const onlineNode = async (ref) => {
    const node = await requireNode(ref);
    if (!node.conn) throw new Error(`${node.name} is offline; the person at it cannot be reached.`);
    return node;
  };

  // ── Messages (W) ─────────────────────────────────────────────────────────
  define({
    name: 'mesh_message_box', tier: 'W', title: 'Show message box',
    description:
      'Show a message box on a device\'s screen to the logged-in user (stays until dismissed or timeout). ' +
      'For a passing notification use mesh_send_toast. The agent does not report whether it was seen.',
    describe: ({ node_id, title, message }) => `Message box on ${node_id}: ${title ? `[${title}] ` : ''}${message}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      message: z.string().min(1).max(4096).describe('Message text'),
      title: z.string().max(128).optional().describe('Window title (default "MeshCentral")'),
      timeout_seconds: z.number().int().positive().max(3600).optional().describe('Close it after this many seconds (default 120)'),
    },
    handler: async ({ node_id, message, title, timeout_seconds }) => {
      const node = await onlineNode(node_id);
      await client.sendRaw({
        action: 'msg', type: 'messagebox', nodeid: node._id, title: title || 'MeshCentral', msg: message,
        timeout: (timeout_seconds ?? 120) * 1000,
      });
      return textResult(`Message box sent to ${node.name}.`);
    },
  });

  define({
    name: 'mesh_open_url', tier: 'W', title: 'Open URL on device',
    description:
      "Open a web page in the default browser of the device's logged-in user (e.g. a support portal or a download " +
      'page you want them to see). http(s) only. Always asks for approval: the page runs on their machine.',
    sensitive: true,
    confirmSummary: ({ node_id, url }) => `Open ${url} in the browser on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      url: z.string().url().max(2048).describe('http:// or https:// URL'),
    },
    handler: async ({ node_id, url }) => {
      if (!/^https?:\/\//i.test(url)) return errorResult('Only http:// and https:// URLs can be opened.');
      const node = await onlineNode(node_id);
      await client.sendRaw({ action: 'msg', type: 'openUrl', nodeid: node._id, url });
      return textResult(`Asked ${node.name} to open ${url}.`);
    },
  });

  // ── Device share links ───────────────────────────────────────────────────
  const ACCESS_BITS = { terminal: 1, desktop: 2, files: 4 };
  // Consent bits per access type: notify, prompt (MeshCentral USERCONSENT_*).
  const CONSENT_BITS = {
    terminal: { notify: 0x02, prompt: 0x10 },
    desktop: { notify: 0x01, prompt: 0x08 },
    files: { notify: 0x04, prompt: 0x20 },
  };
  const DESKTOP_TOOLBAR = 0x40;

  define({
    name: 'mesh_create_share_link', tier: 'A', title: 'Create device share link',
    description:
      'Create a time-limited guest link to ONE device (desktop, terminal and/or files) for someone without a ' +
      'MeshCentral account. Anyone holding the link gets that access until it expires, so keep it short and send it ' +
      'only to the intended person. consent (default prompt) makes the user at the device accept each session.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, guest_name, access, view_only, consent, duration_minutes }) =>
      `Share ${node_id} with guest "${guest_name}": ${access.join('+')}${view_only ? ' (view only)' : ''}, ` +
      `consent ${consent ?? 'prompt'}, valid ${duration_minutes} min`,
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      guest_name: z.string().min(1).max(128).describe('Name of the person the link is for (shown in logs and to the user)'),
      access: z.array(z.enum(Object.keys(ACCESS_BITS))).min(1).describe('What the guest may open'),
      duration_minutes: z.number().int().positive().max(7 * 24 * 60).describe('How long the link works, from now'),
      view_only: z.boolean().optional().describe('Desktop/terminal without input (default false)'),
      consent: z.enum(['prompt', 'notify', 'none']).optional()
        .describe('prompt: the user must accept each session (default); notify: they are told; none: silent'),
    },
    handler: async ({ node_id, guest_name, access, duration_minutes, view_only, consent }) => {
      const mode = consent ?? 'prompt';
      let cf = 0;
      if (mode !== 'none') {
        for (const a of access) cf |= CONSENT_BITS[a].notify | (mode === 'prompt' ? CONSENT_BITS[a].prompt : 0);
        if (access.includes('desktop')) cf |= DESKTOP_TOOLBAR;
      }
      const start = Math.floor(Date.now() / 1000);
      const res = await client.sendCommand({
        action: 'createDeviceShareLink', nodeid: await resolveNodeId(node_id), guestname: guest_name,
        p: access.reduce((m, a) => m | ACCESS_BITS[a], 0), consent: cf, start, end: start + duration_minutes * 60,
        viewOnly: Boolean(view_only),
      }, 15_000);
      if (isServerError(res) || !res?.url) return errorResult(`MeshCentral: ${res?.result ?? 'no link returned'}`);
      return textResult(
        `Share link for "${guest_name}" (id ${res.publicid}), valid until ${new Date((start + duration_minutes * 60) * 1000).toISOString()}:\n` +
        `${res.url}\nRevoke early with mesh_remove_share_link.`
      );
    },
  });

  define({
    name: 'mesh_list_share_links', tier: 'R', title: 'List device share links',
    description: 'List the active guest share links of a device.',
    schema: { node_id: z.string().describe('Device node ID or name') },
    handler: async ({ node_id }) =>
      serverResult(await client.sendCommand({ action: 'deviceShares', nodeid: await resolveNodeId(node_id) }, 15_000)),
  });

  define({
    name: 'mesh_remove_share_link', tier: 'W', title: 'Remove device share link',
    description: 'Revoke a guest share link (public id from mesh_list_share_links / mesh_create_share_link).',
    describe: ({ node_id, public_id }) => `Revoke share link ${public_id} on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name'),
      public_id: z.string().describe('Share link public id'),
    },
    handler: async ({ node_id, public_id }) =>
      serverResult(await client.sendCommand({ action: 'removeDeviceShare', nodeid: await resolveNodeId(node_id), publicid: public_id }, 15_000)),
  });
}
