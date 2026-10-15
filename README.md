# MeshCentral MCP Server

A Model Context Protocol (MCP) server that lets AI assistants operate your MeshCentral panel: inventory devices, run commands, drive interactive terminals, transfer files, and administer the server — under a capability policy you control.

## Features

- **Capability profiles** — the server exposes only the tools your chosen profile allows (`readonly` by default)
- **Built-in diagnostics** — health check, event-log query and service status for Windows and Linux, read-only and approval-free
- **Service history in MeshCentral** — actions are recorded in each device's MeshCentral event log, the AI can leave session summaries there, and read a device's history before diagnosing it
- **Mesh Agent protection** — anything that would stop, restart, kill or remove the agent (or power the device off) is refused unless explicitly overridden and confirmed
- **Interactive terminals** — persistent CMD / PowerShell / shell sessions with a rendered screen that wait for each command to finish
- **Background jobs and multi-device runs** — slow commands keep running and are fetched later; one command can run on many devices at once
- Inventory and monitor devices, groups, users, events, sysinfo, network info, power timeline
- Run commands (CMD / PowerShell / Linux shell) and raw agent-console commands, with output captured back
- Remote file operations over MeshCentral tunnels (list, read, write, upload, download, delete, mkdir, rename, copy, move, find)
- Power actions, Wake-on-LAN, toasts, process list/kill, software inventory
- User / group / permission administration, agent lifecycle, server console
- **Login-token authentication** so you never store a real password
- **Local file jail** so file tools cannot read `.env`, SSH keys, or escape their directory
- **Confirmation** for destructive actions via MCP elicitation (with a token fallback)
- **Output sanitization** and device-output fencing to blunt prompt-injection from managed devices
- WebSocket health check, automatic reconnect with backoff, and path-prefix-aware URLs

## Setup

### 1. Install

```bash
cd meshcentral-mcp
npm install
```

### 2. Configure credentials

Copy `.env.example` to `.env` and fill it in. A `.env` in the project root is loaded automatically (real environment variables win over it).

**Login token (preferred).** Create one under **My Account → Login tokens**. It is a user/password *pair*; the username starts with `~t:`. Both parts are required.

```
MESH_SERVER_URL=https://mesh.yourdomain.com
MESH_TOKEN_USER=~t:xxxxxxxxxxxxxxxx
MESH_TOKEN_PASS=xxxxxxxxxxxxxxxxxxxx
```

Tokens can be given an expiry and revoked without changing the account password.

**Username/password fallback:**

```
MESH_USERNAME=admin
MESH_PASSWORD=yourpassword
```

### 3. Choose a capability profile

The server registers only the tools your profile allows. The default is `readonly`.

| Profile | Tiers | What it can do |
|---------|-------|----------------|
| `readonly` *(default)* | R | Inventory and monitoring only |
| `support` | R, RF, W, X | + remote data read, light writes, command execution & terminals |
| `operations` | + WF, P | + remote file writes, power/process/agent-lifecycle actions |
| `admin` | + A | + user/permission/server administration |

```
MESH_MCP_PROFILE=support
```

Tune a profile with `MESH_MCP_ENABLE_TOOLS` / `MESH_MCP_DISABLE_TOOLS` (comma-separated tool names) and `MESH_MCP_CONFIRM_TIERS`. See [docs/PERMISSIONS.md](docs/PERMISSIONS.md) for the tier model and least-privilege guidance.

### 4. MCP client configuration

```json
{
  "mcpServers": {
    "meshcentral": {
      "command": "node",
      "args": ["path/to/meshcentral-mcp/src/index.js"],
      "env": {
        "MESH_SERVER_URL": "https://mesh.yourdomain.com",
        "MESH_TOKEN_USER": "~t:xxxxxxxxxxxxxxxx",
        "MESH_TOKEN_PASS": "xxxxxxxxxxxxxxxxxxxx",
        "MESH_MCP_PROFILE": "support"
      }
    }
  }
}
```

The same block works for Claude Desktop (`claude_desktop_config.json`) and opencode (`opencode.json`).

## Diagnostics

Fixed, tested read-only scripts for the questions asked on every support call. They are tier RF, so they need no approval, and they run in parallel across devices where noted.

| Tool | Description |
|------|-------------|
| `mesh_health_check` | Health snapshot with problems flagged at the top (`node_id` or `node_ids`, `days`, `deep`). Windows: uptime, CPU, memory, disk space, auto-start services not running, top System/Application errors, critical events, unexpected shutdowns, pending reboot, last hotfix, Defender, time sync; role checks for Hyper-V hosts (VMs, checkpoints), RDS hosts (sessions) and domain controllers (replication; `dcdiag` with `deep`). Linux: uptime, load, memory, disks/inodes, failed units, top journal errors, OOM kills, reboot-required, pending updates, time sync. |
| `mesh_event_log` | Query Windows event logs (any log or channel) by level, time window, provider, event IDs and text; on Linux, the journal by priority, unit, window and text. One line per event, newest first. |
| `mesh_services` | Services that are auto-start but not running (Windows) or failed (Linux) by default; also running / stopped / all, with a name filter. |
| `mesh_device_history` | A device's MeshCentral event log as a timeline: commands run, sessions, agent connects, and notes left by technicians or by this server, plus the device notes. |

`mesh_get_device` and `mesh_list_devices` report whether each agent is online and when it last connected, so checking whether a device is up never needs a command. Device lookups accept the full node ID, the ID hash, or the name; names match case-insensitively and as a unique partial match (`prudecon file` finds `Prudecon-File`).

## Service history and activity log

Two records are kept:

- **MeshCentral device event log.** Actions that change a device (approved commands, terminal sessions and input, file writes, service and power actions, agent lifecycle) are added to that device's **Events** tab as `[MCP] <action> [approval: …] -> OK/FAILED`, attributed to the account the server logs in with. `mesh_log_event` lets the AI add a free-text `[MCP note]`, such as a summary of what was found, changed and left open at the end of a session, and `mesh_device_history` reads it all back next time. `MESH_MCP_DEVICE_EVENTS` controls what is posted: `changes` (default), `all` (also read-only commands and diagnostics), or `off`. MeshCentral itself also logs every `runcommands` call with the command text.
- **Local activity log.** Every non-trivial call, including read-only ones, is appended as JSON lines to `MESH_MCP_AUDIT_LOG` (default `logs/audit.jsonl`; `off` disables): time, devices, action, how it was approved (prompt / session grant / auto-readonly / blocked / denied), outcome and duration. Arguments that look like secrets or file contents are redacted. `mesh_activity` reads it back.

`mesh_set_notes` appends a timestamped line to the device notes by default (`mode: "replace"` overwrites).

## Mesh Agent protection

The Mesh Agent is the only channel to a device, and commands run as its child processes, so stopping or restarting it through a command kills the command that would bring it back: the device goes offline until someone recovers it on site. The server therefore refuses:

- commands and terminal input that would stop, restart, kill, disable, reconfigure or delete the agent (service, process, install directory or `.msh` file), on Windows, Linux and macOS;
- `mesh_kill_process` on the agent's PID, and `mesh_service_action` on the agent's service (a stop or restart of the agent through this tool is refused outright);
- agent-console commands that end or update the agent (`exit`, `kill`, `restart`, `uninstall`, `agentupdate`, …);
- `mesh_uninstall_agent`, `mesh_update_agents`, `mesh_distribute_core`, and power-off or sleep via `mesh_power_action`.

A refused call explains why. If the human explicitly wants the action, the call can be repeated with `allow_agent_disruption: true`; the human is then always prompted, with a warning, and session-wide approvals do not apply.

## Commands, jobs and multiple devices

The Mesh Agent runs **one** `runcommands` at a time per device, and silently ignores a second one sent while it is busy. The server therefore queues commands per device (other devices are not affected), and fails fast with an explanation if the agent reports it is busy with a command the server did not start.

- `mesh_run_command` accepts `node_ids` to run the same command on several devices in parallel with one approval; output is grouped per device.
- A command still running after `timeout_seconds` keeps running as a **background job** and the call returns its `job_id`; `background: true` returns job IDs straight away. `mesh_job_status` lists jobs or returns one job's output (optionally waiting for it). The per-device queue is held until the agent really finishes, up to `MESH_COMMAND_MAX_TIMEOUT_SECONDS`. If the agent disconnects, or reconnects (e.g. it was restarted) while a job is running, the job is failed and the queue moves on, since the command died with the agent. A message about a queued command names the job it is waiting behind, and `mesh_job_cancel` releases a stuck job by ID or every job on a device.
- `head_lines` / `tail_lines` trim output on `mesh_run_command`, `mesh_job_status`, `mesh_terminal_input` and `mesh_terminal_read`. Output over `MESH_MCP_MAX_OUTPUT` keeps the start and the (larger) end.
- CMD's banner, echoed command line and trailing `exit` are stripped from CMD output.
- `mesh_service_action` starts, stops or restarts a service and reports its resulting state; `mesh_kill_process` names the process in its prompt and confirms it is gone afterwards.

## Interactive terminals

`mesh_run_command` waits up to `timeout_seconds` (default `MESH_COMMAND_TIMEOUT_SECONDS` = 300, max `MESH_COMMAND_MAX_TIMEOUT_SECONDS` = 3600) for the command to finish; on timeout the command keeps running on the device. While waiting it sends MCP progress notifications. Some clients enforce their own tool-call timeout as well — in Claude Code, raise it with the `MCP_TOOL_TIMEOUT` environment variable (milliseconds) if long commands are cut off client-side.

Unlike `mesh_run_command` (one-shot, stateless), a terminal session is a live PTY: environment variables, working directory, and running programs persist across inputs.

| Tool | Tier | Description |
|------|------|-------------|
| `mesh_terminal_open` | X | Open a session (`shell`, `cmd`, `powershell`, `powershell-user`, `terminal-user`; default PowerShell on Windows, shell elsewhere; 200x50); returns a `session_id` and the initial screen |
| `mesh_terminal_input` | X | Send a line and wait until the shell prompt returns (or `wait_ms`, default 60 s); reports a still-running command or a dead session. Raw keys with `submit:false` |
| `mesh_terminal_read` | R | Re-read the current screen or the full transcript |
| `mesh_terminal_list` | R | List open sessions |
| `mesh_terminal_close` | X | Close a session |

Output is rendered through a headless terminal emulator, so what you read is the screen a user would see. A terminal is not blocked by a running `mesh_run_command`, which makes it the better choice for several commands on one device. Idle sessions auto-close (`MESH_TERMINAL_IDLE_MINUTES`, default 15); concurrency is capped (`MESH_TERMINAL_MAX_SESSIONS`, default 5).

### Orchestration hint

The server advertises MCP `instructions` on connect suggesting a division of labour: the device-driving loop (`mesh_terminal_*`, `mesh_desktop_*`) is mechanical and latency-bound — one capture per observe→act→observe step — so when orchestrating with multiple models, delegate the driving to a fast subagent (e.g. Haiku at low reasoning) while a stronger model plans and makes decisions. The driver's role is narrow: execute the given steps, read and faithfully describe each returned screen, verify a step landed, and **escalate to the orchestrator** whenever the screen doesn't match the expected next step or anything ambiguous/risky/decision-requiring appears — it does not diagnose or improvise. Because the driver escalates rather than reasons about the unexpected, low reasoning is fine for it throughout. Judgment lives in the orchestrator; perception and execution live in the driver. Either way, read the returned output to verify every step on a live system — don't fire blind sequences.

## Remote desktop control

A "computer-use" loop over MeshCentral's native KVM channel — the agent captures the console and accepts mouse/keyboard input through the server relay, so no inbound RDP port or stored OS credentials are needed. Screenshots are returned as images; coordinates are in **native screen pixels** (reported with every screenshot).

| Tool | Tier | Description |
|------|------|-------------|
| `mesh_desktop_screenshot` | RF | Capture the desktop as a JPEG (one-off by `node_id`, or re-capture an open `session_id`) |
| `mesh_desktop_open` | X | Open an interactive KVM session; returns `session_id` + first screenshot |
| `mesh_desktop_click` | X | Click / double-click / right-click at (x, y), then screenshot |
| `mesh_desktop_move` | X | Move the mouse (no click) |
| `mesh_desktop_type` | X | Type a string, then screenshot |
| `mesh_desktop_key` | X | Press a named key (`enter`, `tab`, `escape`, `win`, `f5`, arrows, …), then screenshot |
| `mesh_desktop_scroll` | X | Scroll the wheel, then screenshot |
| `mesh_desktop_hotkey` | X | Press a key chord (`["ctrl","s"]`, `["alt","f4"]`), then screenshot |
| `mesh_desktop_set_display` | X | Switch which monitor the session shows |
| `mesh_desktop_list` / `mesh_desktop_close` | R / X | Manage sessions |

JPEG tiles are composited into a framebuffer and downscaled to `max_width` (default 960) — small enough to keep the model's per-screenshot vision-ingest cheap while window titles, menus and dialog buttons stay legible; pass a larger `max_width` (up to native) to read fine print on demand. Each action forces a fresh full repaint and waits for the screen to settle, so a screenshot always reflects state at or after the action — not a stale earlier frame. Capture needs an **active graphical console session** on the device; a headless server with no console session has nothing to capture. Idle/concurrency limits: `MESH_DESKTOP_IDLE_MINUTES` (default 10), `MESH_DESKTOP_MAX_SESSIONS` (default 3).

**Streaming.** MeshCentral's KVM is a *push* stream; a session streams continuously while open, and closing it stops the device stream. (An earlier "pause between captures" optimization was removed: pausing the shared KVM slave and then disconnecting could wedge it — no tiles for any later viewer until the agent restarts — on some agents. Not worth wedging a shared resource.) Instead, when the agent is the **only** viewer the session asks the agent for a slow frame rate (`MESH_DESKTOP_IDLE_FRAME_MS`, default 2000 ms; `0` disables), restores full rate for the duration of each capture, and stays at full rate whenever another viewer is attached — so a human watching the same desktop in the MeshCentral UI gets normal continuous video. Changing the rate, unlike pausing, does not wedge the slave (verified across repeated open/close cycles). On a multi-monitor target, screenshots list the available display numbers; select one with `mesh_desktop_set_display` (65535 = all monitors).

Image encoding is pinned to **JPEG** (the tile decoder is JPEG-only); a non-JPEG tile is reported rather than silently dropped. Agent-side conditions that affect input — a locked desktop, Caps Lock, consent prompts, or capture errors — are surfaced in the tool result instead of failing silently.

## Tool catalogue

Each tool carries a capability **tier** (shown in its description). Tiers: **R** read, **RF** remote data read, **W** light write, **X** execution, **WF** remote file write, **P** disruptive/lifecycle, **A** administration.

- **R** — `mesh_server_info`, `mesh_list_devices`, `mesh_get_device`, `mesh_device_history`, `mesh_activity`, `mesh_list_groups`, `mesh_list_users`, `mesh_list_user_groups`, `mesh_get_events`, `mesh_get_notes`, `mesh_get_lastconnects`, `mesh_get_power_timeline`, `mesh_get_sysinfo`, `mesh_get_network_info`, `mesh_list_processes`, `mesh_server_version`, `mesh_server_stats`, `mesh_traffic_stats`, `mesh_server_errors`, `mesh_terminal_read`, `mesh_terminal_list`, `mesh_desktop_list`
- **RF** — `mesh_health_check`, `mesh_event_log`, `mesh_services`, `mesh_job_status`, `mesh_get_device_info`, `mesh_list_software`, `mesh_get_clipboard`, `mesh_file_list`, `mesh_file_read`, `mesh_file_download`, `mesh_file_find`, `mesh_desktop_screenshot`
- **W** — `mesh_set_notes`, `mesh_log_event`, `mesh_job_cancel`, `mesh_edit_device`, `mesh_create_group`, `mesh_edit_group`, `mesh_send_toast`, `mesh_wake_devices`, `mesh_set_clipboard`, `mesh_file_mkdir`
- **X** — `mesh_run_command`, `mesh_agent_console`, `mesh_terminal_open`, `mesh_terminal_input`, `mesh_terminal_close`, `mesh_desktop_open`, `mesh_desktop_click`, `mesh_desktop_move`, `mesh_desktop_type`, `mesh_desktop_key`, `mesh_desktop_hotkey`, `mesh_desktop_scroll`, `mesh_desktop_set_display`, `mesh_desktop_close` (`mesh_desktop_list` is R)
- **WF** — `mesh_file_write`, `mesh_file_upload`, `mesh_file_delete`, `mesh_file_rename`, `mesh_file_copy`, `mesh_file_move`
- **P** — `mesh_power_action`, `mesh_kill_process`, `mesh_service_action`, `mesh_remove_device`, `mesh_uninstall_agent`, `mesh_distribute_core`, `mesh_update_agents`, `mesh_delete_group`
- **A** — `mesh_create_user`, `mesh_delete_user`, `mesh_add_user_to_group`, `mesh_remove_user_from_group`, `mesh_add_device_user`, `mesh_change_device_group`, `mesh_create_invite_link`, `mesh_set_device_consent`, `mesh_create_user_group`, `mesh_delete_user_group`, `mesh_scan_amt`, `mesh_server_console`

Device tools accept a node **name** (case-insensitive, unique partial matches allowed) as well as a full node ID.

## Safety model

- **Least privilege first.** Point the server at a dedicated, non-admin MeshCentral account scoped to the device groups it needs, and pick the narrowest profile. The server can never do more than both the account *and* the profile allow.
- **Confirmation.** Tools in tiers that the profile marks for confirmation (by default X/WF/P/A) require approval before running. With `MESH_MCP_CONFIRM_MODE=auto` (default) the server asks the human through MCP **elicitation** when the client supports it; otherwise it falls back to a single-use **token bound to the exact arguments** (the token is a speed bump against accidental calls, not a substitute for human review). `elicit` requires elicitation; `token` always uses tokens; `off` disables confirmation, except for calls that pass `allow_agent_disruption`, which always prompt. The prompt leads with the action itself (e.g. `Run on PC-01 [PowerShell]: Get-WinEvent ...`) and waits up to `MESH_MCP_APPROVAL_TIMEOUT_MINUTES` (default 30) for an answer; an unanswered prompt fails the call rather than silently switching to token mode.
- **Session approval.** Each prompt offers *approve once*, *approve every action in this tier on this device for this session* (when one device is involved), *approve all calls to this tool for this session*, or *approve every action in this tier for this session* (e.g. all tier X execution: commands, terminal input, desktop control). Device names, not IDs, appear in prompts. Grants last until the MCP server process exits, which for a stdio client is the end of the client session. Disable the choice with `MESH_MCP_SESSION_APPROVAL=false`.
- **Every command says why.** `mesh_run_command`, `mesh_terminal_input` and `mesh_agent_console` require a `purpose`: one plain-English sentence on what the command does and why. It is the first argument (so it shows in a collapsed tool call), the first line of the approval prompt, heads the result together with how the call was approved (`auto-approved (read-only)`, `approved by you`, ...), and is stored with the action in the device's MeshCentral event log. The server instructions also ask the model to repeat the purpose, command and relevant output in its reply, because clients such as Claude Code collapse tool calls and results.
- **Read-only auto-approval.** `mesh_run_command`, `mesh_terminal_input` and `mesh_agent_console` skip the prompt when the command is plainly read-only (`MESH_MCP_AUTO_APPROVE_READONLY`, default on). The classifier (`src/readonly.js`) is an allowlist per dialect: PowerShell `Get-*` cmdlets piped through `Select`/`Where`/`Sort`/`Format`/`Measure`/`ConvertTo-*` (script blocks and hashtables are checked recursively; only a fixed set of harmless methods like `.AddDays()` may be called); CMD/native tools such as `ipconfig /all`, `sc query`, `wevtutil qe`, `reg query`, `net user` (listing only); and POSIX tools such as `cat`/`grep`/`tail`, `journalctl`, `systemctl status`, `ps`, `ss`, `ip addr`. Anything else — chaining (`;`, `&&`), redirection to a file, subexpressions, assignments, variables in CMD, unknown commands, or state-changing flags — asks as usual. Checking whether a device or agent is online needs no command at all: `mesh_get_device` / `mesh_list_devices` report `online`, `connection` and `power`.
- **Mesh Agent protection.** Actions that could cut off remote access are refused unless explicitly overridden, and then always prompted; see [Mesh Agent protection](#mesh-agent-protection).
- **Records.** Device changes are recorded in MeshCentral's per-device event log and every call in a local activity log; see [Service history and activity log](#service-history-and-activity-log).
- **Local file jail.** `mesh_file_download` / `mesh_file_upload` are confined to `MESH_LOCAL_FILE_ROOT` (default `./mcp-files`); `..` and symlink escapes are rejected. `MESH_LOCAL_FILE_ROOT=*` disables the jail (not recommended).
- **Device output is untrusted.** All device-sourced output is stripped of ANSI/control sequences, length-capped (`MESH_MCP_MAX_OUTPUT`, default 100000 chars), and wrapped in explicit markers telling the model to treat it as data, not instructions. This reduces, but does not eliminate, prompt-injection risk — review actions the model takes based on device output.
- **TLS.** `MESH_INSECURE_TLS=true` disables certificate verification; use it only for self-signed certs in a lab.

## Tests

```bash
npm test                 # unit tests (no server needed)
# Live integration tests need a reachable server and an online agent:
MESH_IT=1 MESH_TEST_NODE=<node-id-or-name> npm run test:integration
```

## Compatibility note

MeshCentral's native `software` action is broken in some server releases (it can crash the server), so `mesh_list_software` instead runs a read-only inventory command through the agent. Tested against MeshCentral 1.2.5.

## Contributing

Suggestions and new-feature ideas are welcome.
