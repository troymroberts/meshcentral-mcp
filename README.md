# MeshCentral MCP Server

A Model Context Protocol (MCP) server that lets AI assistants operate your MeshCentral panel: inventory devices, run commands, drive interactive terminals, transfer files, and administer the server — under a capability policy you control.

## Features

- **Capability profiles** — the server exposes only the tools your chosen profile allows (`readonly` by default)
- **Interactive terminals** — persistent CMD / PowerShell / shell sessions with a rendered screen, not just one-shot commands
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

## Interactive terminals

Unlike `mesh_run_command` (one-shot, stateless), a terminal session is a live PTY: environment variables, working directory, and running programs persist across inputs.

| Tool | Tier | Description |
|------|------|-------------|
| `mesh_terminal_open` | X | Open a session (`shell`, `cmd`, `powershell`, `powershell-user`, `terminal-user`); returns a `session_id` and the initial screen |
| `mesh_terminal_input` | X | Send a line (or raw keys with `submit:false`) and get the new output |
| `mesh_terminal_read` | R | Re-read the current screen or the full transcript |
| `mesh_terminal_list` | R | List open sessions |
| `mesh_terminal_close` | X | Close a session |

Output is rendered through a headless terminal emulator, so what you read is the screen a user would see. Idle sessions auto-close (`MESH_TERMINAL_IDLE_MINUTES`, default 15); concurrency is capped (`MESH_TERMINAL_MAX_SESSIONS`, default 5).

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

- **R** — `mesh_server_info`, `mesh_list_devices`, `mesh_get_device`, `mesh_list_groups`, `mesh_list_users`, `mesh_list_user_groups`, `mesh_get_events`, `mesh_get_notes`, `mesh_get_lastconnects`, `mesh_get_power_timeline`, `mesh_get_sysinfo`, `mesh_get_network_info`, `mesh_list_processes`, `mesh_server_version`, `mesh_server_stats`, `mesh_traffic_stats`, `mesh_server_errors`, `mesh_terminal_read`, `mesh_terminal_list`
- **RF** — `mesh_get_device_info`, `mesh_list_software`, `mesh_get_clipboard`, `mesh_file_list`, `mesh_file_read`, `mesh_file_download`, `mesh_file_find`, `mesh_desktop_screenshot`
- **W** — `mesh_set_notes`, `mesh_edit_device`, `mesh_create_group`, `mesh_edit_group`, `mesh_change_device_group`, `mesh_send_toast`, `mesh_wake_devices`, `mesh_set_clipboard`, `mesh_create_invite_link`, `mesh_file_mkdir`, `mesh_file_rename`, `mesh_file_copy`, `mesh_file_move`
- **X** — `mesh_run_command`, `mesh_agent_console`, `mesh_terminal_open`, `mesh_terminal_input`, `mesh_terminal_close`, `mesh_desktop_open`, `mesh_desktop_click`, `mesh_desktop_move`, `mesh_desktop_type`, `mesh_desktop_key`, `mesh_desktop_hotkey`, `mesh_desktop_scroll`, `mesh_desktop_set_display`, `mesh_desktop_close`
- **WF** — `mesh_file_write`, `mesh_file_upload`, `mesh_file_delete`
- **P** — `mesh_power_action`, `mesh_kill_process`, `mesh_remove_device`, `mesh_uninstall_agent`, `mesh_distribute_core`, `mesh_update_agents`, `mesh_delete_group`
- **A** — `mesh_create_user`, `mesh_delete_user`, `mesh_add_user_to_group`, `mesh_remove_user_from_group`, `mesh_add_device_user`, `mesh_create_user_group`, `mesh_delete_user_group`, `mesh_scan_amt`, `mesh_server_console`

Most device tools accept a node **name** as well as a full node ID.

## Safety model

- **Least privilege first.** Point the server at a dedicated, non-admin MeshCentral account scoped to the device groups it needs, and pick the narrowest profile. The server can never do more than both the account *and* the profile allow.
- **Confirmation.** Tools in tiers that the profile marks for confirmation (by default X/WF/P/A) require approval before running. With `MESH_MCP_CONFIRM_MODE=auto` (default) the server asks the human through MCP **elicitation** when the client supports it; otherwise it falls back to a single-use **token bound to the exact arguments** (the token is a speed bump against accidental calls, not a substitute for human review). `elicit` requires elicitation; `token` always uses tokens; `off` disables confirmation.
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
