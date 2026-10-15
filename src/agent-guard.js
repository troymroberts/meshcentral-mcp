// Mesh Agent self-protection.
//
// Every command, terminal and file operation reaches the device through the
// Mesh Agent, and commands run as the agent's child processes. Stopping,
// restarting, killing, disabling or removing the agent therefore cuts off remote
// access - and a "restart" sent through the agent usually never completes,
// because stopping the service kills the command that was meant to start it
// again. These checks catch such actions so they can be refused unless the
// caller explicitly overrides, and even then always prompt the human.

// Names the agent goes by: service ("Mesh Agent", "meshagent"), process
// (MeshAgent.exe), install paths, and the .msh/.db files next to it.
const AGENT_RE = /mesh[\s_-]?agent|meshagent|meshcore|\.msh\b/i;

// Verbs and tools that can stop, kill, disable, reconfigure or delete it.
const DISRUPT_RE = new RegExp(
  [
    'stop', 'restart', 'kill', 'taskkill', 'pkill', 'killall', 'disable', 'mask', 'uninstall', 'fulluninstall',
    'remove', 'delete', 'del', 'erase', 'rm', 'rmdir', 'rd', 'move', 'mv', 'ren', 'rename', 'set-service', 'config',
    'unload', 'bootout', 'update-rc\\.d', 'chkconfig', 'suspend', 'set-content',
    'out-file', 'clear-content', 'new-item', 'copy', 'cp', 'icacls', 'takeown', 'chmod', 'chown', 'reg',
  // Letters/digits only as boundaries, so PowerShell Verb-Noun forms match
  // (Restart-Service, Stop-Process) as well as plain words.
  ].map((w) => `(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`).join('|'),
  'i'
);

// Reason string when `text` (a command line or script) appears to act on the
// Mesh Agent in a disruptive way, else null. Callers skip this for commands the
// read-only classifier has already accepted.
export function agentRisk(text) {
  if (typeof text !== 'string' || !AGENT_RE.test(text)) return null;
  if (!DISRUPT_RE.test(text)) return null;
  return 'it appears to stop, restart, kill, disable, reconfigure or modify the Mesh Agent';
}

// Reason string when a file operation touches the agent's files (its install
// directory, binary, .msh settings or database), else null.
export function agentPathRisk(...paths) {
  const hit = paths.flat().filter((p) => typeof p === 'string').find((p) => AGENT_RE.test(p));
  return hit ? `it writes, moves or deletes Mesh Agent files (${hit})` : null;
}

// True for a process name that is the agent itself.
export function isAgentProcess(name) {
  return typeof name === 'string' && /^mesh[\s_-]?agent(\.exe)?$/i.test(name.trim());
}

// True for a service name that is the agent itself.
export function isAgentService(name) {
  return typeof name === 'string' && AGENT_RE.test(name);
}

// Shown (with the specific reason) when an action is refused.
export const AGENT_GUARD_MESSAGE =
  'BLOCKED - this could cut off remote access to the device. MeshCentral reaches it only through the Mesh Agent: ' +
  'if the agent stops (or the machine is powered off or put to sleep), the device goes offline and needs someone on ' +
  "site to recover it. Commands run as the agent's child processes, so even a \"restart\" sent this way kills the " +
  'command that would bring it back. If the human explicitly wants this anyway, call again with ' +
  'allow_agent_disruption: true; they will be asked to confirm, and session-wide approvals do not apply.';
