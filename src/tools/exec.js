import { z } from 'zod';
import { waitForOutput, SHELLS } from '../terminal.js';
import { isReadOnlyCommand } from '../readonly.js';
import { textResult, deviceResult, errorResult } from '../safety.js';

// X — command execution & terminals
export default function register(ctx) {
  const { define, config, terminals, getNode, resolveNodeId, isWindowsNode, RUN_TYPE_LABEL, readOnlyFor, withProgress, READONLY_AGENT_CONSOLE, runShell, runConsole } = ctx;

  // ════════════════════════════════════════════════════════════════════════
  // X — remote code execution
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_run_command', tier: 'X', title: 'Run command',
    description:
      'Run a shell command on a device and capture its output. type: 0 auto, 1 CMD, 2 PowerShell, 3 Linux/macOS. ' +
      'Plainly read-only commands (a single command or pipeline of Get-*/Select/Where/Format cmdlets, ipconfig, ' +
      'systeminfo, cat/grep/tail/journalctl, systemctl status, ...) run without an approval prompt; chained (;, &&), ' +
      'redirected, or state-changing commands ask the user. The agent runs one command at a time per device ' +
      '(calls to the same device are queued); for several commands on one device use a persistent ' +
      'mesh_terminal_open session instead. ' +
      `Waits up to timeout_seconds (default ${config.commandTimeoutSeconds}) for the command to finish.`,
    annotations: { destructiveHint: true },
    confirmSummary: async ({ node_id, command, type }) => {
      const node = await getNode(node_id).catch(() => null);
      return `Run on ${node?.name ?? node_id} [${RUN_TYPE_LABEL[type ?? 0]}]: ${command}`;
    },
    autoApprove: async ({ node_id, command, type }) => {
      const node = await getNode(node_id);
      return Boolean(node) && readOnlyFor(node, command, type ?? 0);
    },
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      command: z.string().describe('Command to execute'),
      type: z.number().int().min(0).max(3).optional().describe('0 auto, 1 CMD, 2 PowerShell, 3 Linux/macOS'),
      timeout_seconds: z.number().int().positive().max(config.commandMaxTimeoutSeconds).optional()
        .describe(`Max seconds to wait for output (default ${config.commandTimeoutSeconds}, max ${config.commandMaxTimeoutSeconds}). Raise for slow log queries.`),
    },
    handler: async ({ node_id, command, type, timeout_seconds }, extra) => {
      const node = await getNode(node_id);
      if (!node) return errorResult(`No device matching '${node_id}'`);
      const timeoutMs = (timeout_seconds ?? config.commandTimeoutSeconds) * 1000;
      const out = await withProgress(extra, `Running on ${node.name}`, () => runShell(node, command, type ?? 0, timeoutMs));
      const prompt = type === 2 ? 'PS' : type === 1 ? 'CMD' : '$';
      return deviceResult(out || '(no output)', `${prompt} ${node.name}> ${command}`);
    },
  });

  define({
    name: 'mesh_agent_console', tier: 'X', title: 'Agent console',
    description: 'Run a MeshAgent console command and capture its output (e.g. "help", "coreinfo", "netinfo", "service").',
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, command }) => `Agent console on ${node_id}: ${command}`,
    autoApprove: async ({ command }) => READONLY_AGENT_CONSOLE.has(command.trim().toLowerCase()),
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      command: z.string().describe('Agent console command'),
    },
    handler: async ({ node_id, command }) => {
      const node = await getNode(node_id);
      if (!node) return errorResult(`No device matching '${node_id}'`);
      const out = await runConsole(node, command);
      return deviceResult(out || '(no response from agent)', `agent ${node.name}> ${command}`);
    },
  });

  // ── Interactive terminal (X) ─────────────────────────────────────────────
  const shellList = Object.keys(SHELLS).join(', ');
  define({
    name: 'mesh_terminal_open', tier: 'X', title: 'Open terminal',
    description:
      `Open an interactive terminal session to a device and return a session_id plus the initial screen. ` +
      `Shells: ${shellList}. Use mesh_terminal_input to type, mesh_terminal_read to re-read, mesh_terminal_close to end.`,
    annotations: { destructiveHint: true },
    confirmSummary: ({ node_id, shell }) => `Open ${shell || 'shell'} terminal on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      shell: z.enum(Object.keys(SHELLS)).optional().describe(`Shell type (default "shell"): ${shellList}`),
      cols: z.number().int().positive().optional().describe('Terminal columns (default 120)'),
      rows: z.number().int().positive().optional().describe('Terminal rows (default 32)'),
    },
    handler: async ({ node_id, shell, cols, rows }) => {
      const session = await terminals.open({ nodeId: await resolveNodeId(node_id), shell: shell ?? 'shell', cols: cols ?? 120, rows: rows ?? 32 });
      await waitForOutput(session, { quietMs: 700, maxMs: 8_000 });
      return deviceResult(session.screen(), `Terminal opened. session_id=${session.id} shell=${session.shell}\nInitial screen:`);
    },
  });

  define({
    name: 'mesh_terminal_input', tier: 'X', title: 'Terminal input',
    description:
      'Send input to an open terminal session and return the new output. By default a carriage return is appended ' +
      '(submit=true), so `input` is run as a command line. Set submit=false to send raw keys (e.g. control sequences). ' +
      'Output is collected until it goes quiet or wait_ms elapses; a long-running command keeps running, so read the ' +
      'rest later with mesh_terminal_read. Read-only command lines run without an approval prompt.',
    annotations: { destructiveHint: true },
    confirmSummary: ({ session_id, input }) => {
      let where = `terminal ${session_id}`;
      try { const t = terminals.get(session_id); where = `${t.shell} terminal ${session_id}`; } catch {}
      return `Type into ${where}: ${input}`;
    },
    // A submitted command line in a known shell can be auto-approved when it is
    // read-only. Raw keystrokes (submit=false) always ask.
    autoApprove: async ({ session_id, input, submit }) => {
      if (submit === false) return false;
      const session = terminals.get(session_id);
      let dialect = { cmd: 'cmd', powershell: 'powershell', 'powershell-user': 'powershell', shell: 'posix' }[session.shell];
      if (session.shell === 'terminal-user') {
        const node = await getNode(session.nodeId);
        dialect = node && (isWindowsNode(node) ? 'cmd' : 'posix');
      }
      return Boolean(dialect) && isReadOnlyCommand(input, dialect);
    },
    schema: {
      session_id: z.string().describe('Session ID from mesh_terminal_open'),
      input: z.string().describe('Text to send'),
      submit: z.boolean().optional().describe('Append a carriage return (default true)'),
      wait_ms: z.number().int().positive().max(600_000).optional().describe('Max ms to wait for output to settle (default 15000, max 600000)'),
    },
    handler: async ({ session_id, input, submit, wait_ms }) => {
      const session = terminals.get(session_id);
      if (!session.isOpen) return errorResult(`Terminal ${session_id} is closed (${session.closedReason || 'unknown'}).`);
      const before = session.renderedLines();
      session.send(submit === false ? input : input + '\r');
      await waitForOutput(session, { quietMs: 800, maxMs: wait_ms ?? 15_000 });
      const after = session.renderedLines();

      // Return the rendered-screen delta: the lines appended since the input. xterm
      // has already collapsed interactive redraws, so this is clean for CMD, bash,
      // and PowerShell/PSReadLine alike. Back up one line to include the prompt the
      // command was typed on, for context.
      const limit = Math.min(before.length, after.length);
      let common = 0;
      while (common < limit && before[common] === after[common]) common++;
      if (common > 0) common -= 1;
      const delta = after.slice(common).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      return deviceResult(delta || '(no new output)', `[${session.shell} ${session_id}] > ${input}`);
    },
  });

  define({
    name: 'mesh_terminal_read', tier: 'R', title: 'Read terminal',
    description: 'Re-read an open terminal session without sending input. mode "screen" (current view) or "transcript" (full scrollback).',
    schema: {
      session_id: z.string().describe('Session ID from mesh_terminal_open'),
      mode: z.enum(['screen', 'transcript']).optional().describe('Default "screen"'),
    },
    handler: async ({ session_id, mode }) => {
      const session = terminals.get(session_id);
      const text = mode === 'transcript' ? session.transcript() : session.screen();
      return deviceResult(text, `Terminal ${session_id} (${mode || 'screen'})${session.isOpen ? '' : ' [CLOSED]'}:`);
    },
  });

  define({
    name: 'mesh_terminal_list', tier: 'R', title: 'List terminals',
    description: 'List open terminal sessions managed by this server.',
    handler: async () => textResult(terminals.list()),
  });

  define({
    name: 'mesh_terminal_close', tier: 'X', title: 'Close terminal',
    description: 'Close an open terminal session.',
    schema: { session_id: z.string().describe('Session ID from mesh_terminal_open') },
    handler: async ({ session_id }) => {
      const session = terminals.get(session_id);
      session.close('closed by user');
      return textResult(`Terminal ${session_id} closed.`);
    },
  });
}
