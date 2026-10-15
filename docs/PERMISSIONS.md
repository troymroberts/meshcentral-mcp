# Permission Control — MeshCentral MCP

Status: **implemented**. Set `MESH_MCP_PROFILE` (default `readonly`); the server
registers only the tools that profile allows.

---

## 1. The problem this addresses

Without a policy, the server would hand the model every tool the moment it starts,
each executing against a single MeshCentral account — no allow-list, no tiering, no
confirmation, no scoping. Profiles plus per-tier confirmation give you a graduated
allow-list; the MeshCentral account itself remains the outer bound (Layer 0 below).

Key risks:
- Arbitrary code execution as SYSTEM/root on any managed device
- Arbitrary read/write/delete of any remote file
- Agent removal / core replacement
- Identity and access management (privilege escalation)
- Server console access

---

## 2. Layer 0 — MeshCentral-side least privilege (do this first)

Create an `mcp-bot` user with `siteadmin = 0`. Grant device access per group
through a user group link with an explicit bitmask.

### Login tokens instead of a password

Create a login token in the MeshCentral web UI under **My Account → Login tokens**.
MeshCentral returns a **pair**: a token username (always prefixed `~t:`) and a token
password. Both are required. Tokens can be given an expiry and revoked without changing
the account password.

```
MESH_TOKEN_USER=~t:xxxxxxxxxxxxxxxx
MESH_TOKEN_PASS=xxxxxxxxxxxxxxxxxxxx
```

Or combined:
```
MESH_TOKEN=~t:xxxxxxxxxxxxxxxx,xxxxxxxxxxxxxxxxxxxx
```

---

## 3. Layer 1 — Capability tiers

| Tier | Meaning |
|------|---------|
| **R** | Read / inventory (no mutation) |
| **RF** | Remote data read (exfiltration risk) |
| **W** | Low-impact write (reversible, metadata) |
| **X** | Remote code execution |
| **WF** | Remote file write (destruction / persistence) |
| **P** | Disruptive / agent lifecycle |
| **A** | Estate / IAM administration |

### Built-in profiles

| Profile | Tiers | Confirmation |
|---------|-------|-------------|
| `readonly` **(default)** | R | — |
| `support` | R, RF, W, X | X confirmed |
| `operations` | R, RF, W, X, WF, P | X, WF, P confirmed |
| `admin` | all | X, WF, P, A confirmed |

Set the profile with `MESH_MCP_PROFILE`. Adjust it without switching profiles using:

- `MESH_MCP_ENABLE_TOOLS` / `MESH_MCP_DISABLE_TOOLS` — comma-separated tool names to force on/off
- `MESH_MCP_CONFIRM_TIERS` — comma-separated tiers that require confirmation (default X, WF, P, A in every profile — including tools switched on with `MESH_MCP_ENABLE_TOOLS` outside their profile)
- `MESH_MCP_CONFIRM_MODE` — `auto` (elicitation, else token), `elicit`, `token`, or `off`

Confirmation prefers MCP **elicitation** (a prompt to the human). When the client
cannot elicit, it falls back to a single-use token **bound to the exact tool
arguments** — a guard against accidental calls, not a replacement for human review.

Further controls on top of the tiers:

- `MESH_MCP_AUTO_APPROVE_READONLY` (default on) — commands the read-only classifier
  recognises skip confirmation. The built-in diagnostics (`mesh_health_check`,
  `mesh_event_log`, `mesh_services`) are tier RF and never need confirmation.
- `MESH_MCP_SESSION_APPROVAL` (default on) — prompts can grant approval for one
  device, one tool, or one tier for the rest of the session.
- **Mesh Agent protection** — actions that could cut off remote access (stopping,
  restarting, killing, reconfiguring or removing the agent; power-off or sleep;
  agent updates and core pushes) are refused regardless of tier unless the call
  passes `allow_agent_disruption: true`, and then always prompt; session grants
  never cover them.

---

## 4. Local file access

`mesh_file_download` and `mesh_file_upload` are the only tools that touch the disk
of the machine running this server. They are confined to `MESH_LOCAL_FILE_ROOT`
(default `./mcp-files`, created on startup); paths outside it — including via `..`
or a symbolic link — are rejected.

Setting `MESH_LOCAL_FILE_ROOT=*` removes the restriction and lets the agent read and
write anywhere the process can, including its own `.env`. Not recommended.

---

## 5. Recommendations

1. **Use a dedicated, non-admin service account** — never point the MCP at a full site administrator
2. **Use login tokens** instead of account passwords — set a non-zero expiry
3. **Withhold `MESHRIGHT_REMOTECOMMAND`** if the agent never needs to run commands
4. **Enable consent flags** on device groups for terminal/desktop/file sessions
5. **Keep `MESH_LOCAL_FILE_ROOT`** restricted to a dedicated directory
6. **Keep `MESH_MCP_DEVICE_EVENTS` on** so device changes made through the MCP appear
   in MeshCentral's own per-device event log, attributed to the MCP account
