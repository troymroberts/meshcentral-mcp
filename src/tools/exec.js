import { z } from 'zod';
import { waitForOutput, waitForPrompt, PROMPT_RE, SHELLS } from '../terminal.js';
import { isReadOnlyCommand } from '../readonly.js';
import { agentRisk } from '../agent-guard.js';
import { textResult, deviceResult, errorResult, trimLines } from '../safety.js';

// X — command execution, background jobs & terminals
export default function register(ctx) {
  const {
    define, config, terminals, getNode, requireNode, isWindowsNode, RUN_TYPE_LABEL, readOnlyFor, withProgress,
    READONLY_AGENT_CONSOLE, startShellJob, waitForJob, cancelJob, jobs, runningJobs, jobFinished, stillRunningMessage, runConsole,
  } = ctx;

  const lineOptions = {
    head_lines: z.number().int().positive().optional().describe('Return only the first N lines of output'),
    tail_lines: z.number().int().positive().optional().describe('Return only the last N lines of output (best for logs)'),
  };
  const trimmed = (text, { head_lines, tail_lines }) => trimLines(text, { head: head_lines, tail: tail_lines });

  // node_id or node_ids -> device list (deduplicated). Throws on unknown devices.
  async function targetNodes({ node_id, node_ids }) {
    const refs = [...(node_id ? [node_id] : []), ...(node_ids ?? [])];
    if (!refs.length) throw new Error('Provide node_id or node_ids.');
    const nodes = [];
    for (const ref of refs) {
      const n = await requireNode(ref);
      if (!nodes.some((x) => x._id === n._id)) nodes.push(n);
    }
    return nodes;
  }

  const promptFor = (type) => (type === 2 ? 'PS' : type === 1 ? 'CMD' : '$');

  // ════════════════════════════════════════════════════════════════════════
  // X — remote code execution
  // ════════════════════════════════════════════════════════════════════════

  define({
    name: 'mesh_run_command', tier: 'X', title: 'Run command', explain: true,
    description:
      'Run a shell command on one device (node_id) or the same command on several (node_ids, run in parallel, one ' +
      'approval) and capture the output. type: 0 auto, 1 CMD, 2 PowerShell, 3 Linux/macOS. ' +
      'Plainly read-only commands run without an approval prompt (Get-* pipelines, ipconfig, wevtutil qe, ' +
      'cat/grep/journalctl, systemctl status, ... and multi-line read-only scripts); state-changing commands ask the ' +
      'user. The agent runs one command at a time per device (this server queues them); for several commands on one ' +
      'device prefer a persistent mesh_terminal_open session. ' +
      `Waits up to timeout_seconds (default ${config.commandTimeoutSeconds}); a command still running then keeps ` +
      'going as a background job (its job_id is returned - fetch with mesh_job_status). background=true returns ' +
      'job IDs immediately. Commands that would stop/restart/modify the Mesh Agent are refused.',
    annotations: { destructiveHint: true },
    confirmSummary: async ({ node_id, node_ids, command, type }) => {
      const nodes = await targetNodes({ node_id, node_ids }).catch(() => null);
      const where = nodes ? nodes.map((n) => n.name).join(', ') : [node_id, ...(node_ids ?? [])].filter(Boolean).join(', ');
      return `Run on ${where} [${RUN_TYPE_LABEL[type ?? 0]}]: ${command}`;
    },
    autoApprove: async ({ node_id, node_ids, command, type }) => {
      const nodes = await targetNodes({ node_id, node_ids });
      return nodes.every((n) => readOnlyFor(n, command, type ?? 0));
    },
    agentRisk: async ({ command }) => agentRisk(command),
    describe: async ({ node_id, node_ids, command, type }) => `Run [${RUN_TYPE_LABEL[type ?? 0]}]: ${command}`,
    schema: {
      node_id: z.string().optional().describe('Device node ID or name (must be online)'),
      node_ids: z.array(z.string()).optional().describe('Several devices to run the same command on, in parallel'),
      command: z.string().describe('Command or script to execute'),
      type: z.number().int().min(0).max(3).optional().describe('0 auto, 1 CMD, 2 PowerShell, 3 Linux/macOS'),
      timeout_seconds: z.number().int().positive().max(config.commandMaxTimeoutSeconds).optional()
        .describe(`Max seconds to wait (default ${config.commandTimeoutSeconds}, max ${config.commandMaxTimeoutSeconds}); after that the command continues as a background job`),
      background: z.boolean().optional().describe('Return job IDs immediately instead of waiting (for slow jobs: dcdiag, sfc, large log queries)'),
      ...lineOptions,
    },
    handler: async ({ node_id, node_ids, command, type, timeout_seconds, background, head_lines, tail_lines }, extra) => {
      const nodes = await targetNodes({ node_id, node_ids });
      const runType = type ?? 0;
      const started = nodes.map((node) => ({ node, job: startShellJob(node, command, runType) }));
      if (background) {
        return textResult(
          `Started ${started.length} background job(s) - fetch results with mesh_job_status:\n` +
          started.map(({ node, job }) => `  ${node.name}: ${job.id} (${job.status})`).join('\n')
        );
      }
      const timeoutMs = (timeout_seconds ?? config.commandTimeoutSeconds) * 1000;
      const label = nodes.length === 1 ? `Running on ${nodes[0].name}` : `Running on ${nodes.length} devices`;
      await withProgress(extra, label, () => Promise.all(started.map(({ job }) => waitForJob(job, timeoutMs))));

      if (nodes.length === 1) {
        const { node, job } = started[0];
        if (job.status === 'failed') return errorResult(job.error);
        if (!jobFinished(job)) return errorResult(stillRunningMessage(job, timeoutMs));
        return deviceResult(trimmed(job.output || '(no output)', { head_lines, tail_lines }), `${promptFor(runType)} ${node.name}> ${command}`);
      }
      const sections = started.map(({ node, job }) => {
        const secs = job.endedAt && job.startedAt ? ` ${((job.endedAt - job.startedAt) / 1000).toFixed(1)}s` : '';
        if (job.status === 'done') return `=== ${node.name} (ok${secs}) ===\n${trimmed(job.output || '(no output)', { head_lines, tail_lines })}`;
        if (job.status === 'failed') return `=== ${node.name} (FAILED) ===\n${job.error}`;
        return `=== ${node.name} (still ${job.status}: ${job.id}) ===\nFetch later with mesh_job_status.`;
      });
      const ok = started.filter(({ job }) => job.status === 'done').length;
      return deviceResult(sections.join('\n\n'), `${promptFor(runType)} [${nodes.length} devices, ${ok} ok]> ${command}`);
    },
  });

  define({
    name: 'mesh_job_status', tier: 'RF', title: 'Command job status',
    description:
      'Status and output of mesh_run_command jobs (background or timed-out commands). Omit job_id to list recent ' +
      'jobs; pass job_id (and optionally wait_seconds) to get one job\'s result.',
    audit: false,
    schema: {
      job_id: z.string().optional().describe('Job ID from mesh_run_command'),
      wait_seconds: z.number().int().min(0).max(600).optional().describe('Wait up to this long for the job to finish (default 0)'),
      ...lineOptions,
    },
    handler: async ({ job_id, wait_seconds, head_lines, tail_lines }, extra) => {
      const brief = (j) => ({
        job_id: j.id, device: j.nodeName, status: j.status, command: j.command.length > 120 ? j.command.slice(0, 120) + '…' : j.command,
        queued: new Date(j.queuedAt).toISOString(),
        ...(j.startedAt ? { running_seconds: Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000) } : {}),
      });
      if (!job_id) {
        const list = [...jobs.values()].filter((j) => j.visible).slice(-30).reverse().map(brief);
        return textResult(list.length ? list : 'No command jobs in this session.');
      }
      const job = jobs.get(job_id);
      if (!job) return errorResult(`No job '${job_id}' (jobs last for this server session; the 200 most recent are kept).`);
      if (wait_seconds) await withProgress(extra, `Waiting for ${job.id}`, () => waitForJob(job, wait_seconds * 1000));
      if (job.status === 'failed') return errorResult(`${job.id} on ${job.nodeName} failed: ${job.error}`);
      if (!jobFinished(job)) {
        const ahead = job.status === 'queued' ? runningJobs.get(job.nodeId) : null;
        return textResult({
          ...brief(job),
          ...(ahead ? { queued_behind: brief(ahead) } : {}),
          note: 'Not finished yet; call again (optionally with wait_seconds). If it is stuck, mesh_job_cancel releases it.',
        });
      }
      return deviceResult(trimmed(job.output || '(no output)', { head_lines, tail_lines }),
        `${job.id} ${promptFor(job.type)} ${job.nodeName}> ${job.command} (done in ${Math.round((job.endedAt - job.startedAt) / 1000)}s)`);
    },
  });

  define({
    name: 'mesh_job_cancel', tier: 'W', title: 'Cancel command job',
    description:
      'Stop tracking a mesh_run_command job and release the device\'s command queue. Use it when a job is stuck - ' +
      'typically after the Mesh Agent was restarted and the command died with it (normally detected automatically). ' +
      'A queued job is dropped before it is sent. A running one is only abandoned here: if the command is really ' +
      'still running on the device, the agent will refuse new commands until it ends.',
    schema: {
      job_id: z.string().optional().describe('Job to cancel'),
      node_id: z.string().optional().describe('Or: cancel the running and queued jobs for this device'),
    },
    change: () => false,
    describe: async ({ job_id, node_id }) => `Cancel ${job_id ? `job ${job_id}` : `jobs on ${node_id}`}`,
    handler: async ({ job_id, node_id }) => {
      let targets;
      if (job_id) {
        const job = jobs.get(job_id);
        if (!job) return errorResult(`No job '${job_id}'.`);
        targets = [job];
      } else if (node_id) {
        const node = await requireNode(node_id);
        targets = [...jobs.values()].filter((j) => j.nodeId === node._id && !jobFinished(j));
      } else {
        return errorResult('Provide job_id or node_id.');
      }
      const cancelled = targets.filter((j) => cancelJob(j, 'Cancelled by request (mesh_job_cancel).'));
      if (!cancelled.length) return textResult('Nothing to cancel (job already finished).');
      return textResult(`Cancelled ${cancelled.map((j) => `${j.id} on ${j.nodeName}`).join(', ')}. The device's queue is released.`);
    },
  });

  // MeshAgent console commands that end, restart, update or reconfigure the agent itself.
  const AGENT_CONSOLE_RISK = new Set(['exit', 'kill', 'restart', 'uninstall', 'fullupdate', 'agentupdate', 'agentupdateex', 'service', 'die']);

  define({
    name: 'mesh_agent_console', tier: 'X', title: 'Agent console', explain: true,
    description: 'Run a MeshAgent console command and capture its output (e.g. "help", "coreinfo", "netinfo", "versions").',
    annotations: { destructiveHint: true },
    confirmSummary: async ({ node_id, command }) => `Agent console on ${node_id}: ${command}`,
    autoApprove: async ({ command }) => READONLY_AGENT_CONSOLE.has(command.trim().toLowerCase()),
    agentRisk: async ({ command }) => {
      const word = command.trim().split(/\s+/)[0].toLowerCase();
      return AGENT_CONSOLE_RISK.has(word) ? `agent console "${word}" acts on the agent process itself` : null;
    },
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      command: z.string().describe('Agent console command'),
    },
    handler: async ({ node_id, command }) => {
      const node = await requireNode(node_id);
      const out = await runConsole(node, command);
      return deviceResult(out || '(no response from agent)', `agent ${node.name}> ${command}`);
    },
  });

  // ── Interactive terminal (X) ─────────────────────────────────────────────
  const shellList = Object.keys(SHELLS).join(', ');
  const dialectOf = async (session) => {
    const d = { cmd: 'cmd', powershell: 'powershell', 'powershell-user': 'powershell', shell: 'posix' }[session.shell];
    if (d) return d;
    const node = await getNode(session.nodeId).catch(() => null);
    return node ? (isWindowsNode(node) ? 'cmd' : 'posix') : null;
  };

  define({
    name: 'mesh_terminal_open', tier: 'X', title: 'Open terminal',
    description:
      'Open a persistent interactive terminal on a device and return a session_id plus the initial screen. ' +
      'Best for several commands on one device: state persists between inputs and it is not blocked by a running ' +
      `mesh_run_command. Shells: ${shellList} (default: powershell on Windows, shell elsewhere). ` +
      'Use mesh_terminal_input to run commands, mesh_terminal_read to re-read, mesh_terminal_close when done.',
    annotations: { destructiveHint: true },
    confirmSummary: async ({ node_id, shell }) => `Open ${shell || 'default'} terminal on ${node_id}`,
    schema: {
      node_id: z.string().describe('Device node ID or name (must be online)'),
      shell: z.enum(Object.keys(SHELLS)).optional().describe(`Shell type: ${shellList}. Default: powershell on Windows, shell elsewhere`),
      cols: z.number().int().positive().optional().describe('Terminal columns (default 200, so wide tables are not cut off)'),
      rows: z.number().int().positive().optional().describe('Terminal rows (default 50)'),
    },
    handler: async ({ node_id, shell, cols, rows }) => {
      const node = await requireNode(node_id);
      const chosen = shell ?? (isWindowsNode(node) ? 'powershell' : 'shell');
      const session = await terminals.open({ nodeId: node._id, shell: chosen, cols: cols ?? 200, rows: rows ?? 50 });
      await waitForOutput(session, { quietMs: 700, maxMs: 8_000 });
      return deviceResult(session.screen(), `Terminal opened on ${node.name}. session_id=${session.id} shell=${session.shell}\nInitial screen:`);
    },
  });

  define({
    name: 'mesh_terminal_input', tier: 'X', title: 'Terminal input', explain: true,
    description:
      'Send input to an open terminal and return the new output. By default a carriage return is appended ' +
      '(submit=true) and the call waits until the command finishes (the shell prompt returns) or wait_ms elapses ' +
      '(default 60000); a command still running keeps going - poll with mesh_terminal_read. For interactive ' +
      'programs that never return to the prompt, pass a small wait_ms. submit=false sends raw keys (control ' +
      'sequences) and returns once output goes quiet. Read-only command lines run without an approval prompt.',
    annotations: { destructiveHint: true },
    confirmSummary: async ({ session_id, input }) => {
      let where = `terminal ${session_id}`;
      try { const t = terminals.get(session_id); where = `${t.shell} terminal ${session_id}`; } catch {}
      return `Type into ${where}: ${input}`;
    },
    // A submitted command line in a known shell can be auto-approved when it is
    // read-only. Raw keystrokes (submit=false) always ask.
    autoApprove: async ({ session_id, input, submit }) => {
      if (submit === false) return false;
      const dialect = await dialectOf(terminals.get(session_id));
      return Boolean(dialect) && isReadOnlyCommand(input, dialect);
    },
    agentRisk: async ({ input }) => agentRisk(input),
    change: (args, approval) => approval !== 'auto-readonly',
    schema: {
      session_id: z.string().describe('Session ID from mesh_terminal_open'),
      input: z.string().describe('Text to send'),
      submit: z.boolean().optional().describe('Append a carriage return (default true)'),
      wait_ms: z.number().int().positive().max(600_000).optional().describe('Max ms to wait for the command to finish (default 60000, max 600000)'),
      ...lineOptions,
    },
    handler: async ({ session_id, input, submit, wait_ms, head_lines, tail_lines }) => {
      const session = terminals.get(session_id);
      if (!session.isOpen) return errorResult(`Terminal ${session_id} is closed (${session.closedReason || 'unknown'}). Open a new one.`);
      const before = session.renderedLines();
      session.send(submit === false ? input : input + '\r');
      let note = '';
      if (submit === false) {
        await waitForOutput(session, { quietMs: 800, maxMs: wait_ms ?? 15_000 });
      } else {
        const dialect = await dialectOf(session);
        const r = await waitForPrompt(session, { promptRe: PROMPT_RE[dialect] ?? PROMPT_RE.posix, maxMs: wait_ms ?? 60_000 });
        if (r.dead) {
          note = '\nWARNING: the terminal did not respond at all (not even an echo of the input). The session is ' +
            'probably dead: close it and open a new one.';
        } else if (r.closed) {
          note = `\nThe terminal closed (${session.closedReason || 'unknown'}).`;
        } else if (!r.prompt) {
          note = `\nNOTE: no shell prompt after ${Math.round(r.ms / 1000)}s - the command is probably still running (or an ` +
            'interactive program has the terminal). Use mesh_terminal_read to check later.';
        }
      }
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
      const node = await getNode(session.nodeId).catch(() => null);
      return deviceResult(trimmed(delta || '(no new output)', { head_lines, tail_lines }),
        `[${session.shell} ${session_id}${node ? ` on ${node.name}` : ''}] > ${input}${note}`);
    },
  });

  define({
    name: 'mesh_terminal_read', tier: 'R', title: 'Read terminal',
    description: 'Re-read an open terminal session without sending input. mode "screen" (current view) or "transcript" (full scrollback).',
    schema: {
      session_id: z.string().describe('Session ID from mesh_terminal_open'),
      mode: z.enum(['screen', 'transcript']).optional().describe('Default "screen"'),
      ...lineOptions,
    },
    handler: async ({ session_id, mode, head_lines, tail_lines }) => {
      const session = terminals.get(session_id);
      const text = mode === 'transcript' ? session.transcript() : session.screen();
      return deviceResult(trimmed(text, { head_lines, tail_lines }), `Terminal ${session_id} (${mode || 'screen'})${session.isOpen ? '' : ' [CLOSED]'}:`);
    },
  });

  define({
    name: 'mesh_terminal_list', tier: 'R', title: 'List terminals',
    description: 'List open terminal sessions managed by this server.',
    handler: async () => textResult(terminals.list()),
  });

  define({
    name: 'mesh_terminal_close', tier: 'X', title: 'Close terminal', confirm: false,
    description: 'Close an open terminal session.',
    schema: { session_id: z.string().describe('Session ID from mesh_terminal_open') },
    describe: async ({ session_id }) => `Close terminal ${session_id}`,
    handler: async ({ session_id }) => {
      const session = terminals.get(session_id);
      session.close('closed by user');
      return textResult(`Terminal ${session_id} closed.`);
    },
  });
}
