import fs from 'fs';
import path from 'path';

// Activity record for everything the MCP server does to devices.
//
// Two sinks:
//  - a local JSON-lines file (every non-trivial call, including read-only ones),
//    read back by the mesh_activity tool;
//  - MeshCentral's own per-device event log (setDeviceEvent), so a service
//    history shows up in the device's Events tab next to MeshCentral's events.
//    MESH_MCP_DEVICE_EVENTS: off | changes (default: actions that change a
//    device or needed approval) | all (also read-only commands and diagnostics).

const SECRET_KEY = /pass|token|secret|content|data$/i;

// Arguments as recorded: secrets and bulky payloads replaced, long strings cut.
export function redactArgs(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'confirm_token') continue;
    if (SECRET_KEY.test(k)) out[k] = typeof v === 'string' ? `[${v.length} chars]` : '[redacted]';
    else if (typeof v === 'string' && v.length > 2000) out[k] = v.slice(0, 2000) + '…';
    else out[k] = v;
  }
  return out;
}

export class AuditLog {
  #file;
  #client;
  #deviceEvents;
  #recent = []; // in-memory tail, for when the file is unavailable

  constructor({ file = null, client = null, deviceEvents = 'changes' } = {}) {
    if (!['off', 'changes', 'all'].includes(deviceEvents)) {
      throw new Error(`Unknown MESH_MCP_DEVICE_EVENTS '${deviceEvents}'. Valid: off, changes, all`);
    }
    this.#file = file;
    this.#client = client;
    this.#deviceEvents = deviceEvents;
    if (file) {
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {}
    }
  }

  get file() { return this.#file; }
  get deviceEventsMode() { return this.#deviceEvents; }

  // entry: { tool, tier, nodes: [{id,name}], summary, approval, ok, error, ms, change }
  record(entry) {
    const line = { ts: new Date().toISOString(), ...entry };
    this.#recent.push(line);
    if (this.#recent.length > 500) this.#recent.shift();
    if (this.#file) {
      try { fs.appendFileSync(this.#file, JSON.stringify(line) + '\n', { mode: 0o600 }); } catch {}
    }
    if (this.#shouldPostEvent(entry)) {
      const msg = AuditLog.eventMessage(entry);
      for (const n of entry.nodes ?? []) this.deviceEvent(n.id, msg);
    }
  }

  #shouldPostEvent(entry) {
    if (this.#deviceEvents === 'off' || !entry.nodes?.length || entry.noEvent) return false;
    if (this.#deviceEvents === 'all') return true;
    return Boolean(entry.change);
  }

  static eventMessage(entry) {
    const approval = entry.approval && entry.approval !== 'not-required' ? ` [approval: ${entry.approval}]` : '';
    const outcome = entry.outcome
      ?? (entry.ok ? `OK${entry.ms != null ? ` (${(entry.ms / 1000).toFixed(1)}s)` : ''}` : `FAILED: ${String(entry.error ?? 'error').replace(/^ERROR: /, '').slice(0, 300)}`);
    return `[MCP] ${entry.summary}${approval} -> ${outcome}`;
  }

  // Add a free-text event to a device's MeshCentral event log.
  async deviceEvent(nodeId, msg) {
    if (!this.#client || !nodeId) return;
    const text = String(msg).slice(0, 3500); // server limit is 4096 after URI-encoding
    try {
      await this.#client.sendRaw({ action: 'setDeviceEvent', nodeid: nodeId, msg: encodeURIComponent(text) });
    } catch {}
  }

  // Most recent entries, newest last, optionally filtered.
  read({ limit = 50, nodeName = null, tool = null, sinceMs = null } = {}) {
    let entries = this.#recent;
    if (this.#file) {
      try {
        entries = fs.readFileSync(this.#file, 'utf8').trim().split('\n').filter(Boolean).map((l) => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
      } catch {}
    }
    const needle = nodeName?.toLowerCase();
    const filtered = entries.filter((e) =>
      (!needle || e.nodes?.some((n) => n.name?.toLowerCase().includes(needle) || n.id === nodeName)) &&
      (!tool || e.tool === tool) &&
      (!sinceMs || Date.parse(e.ts) >= sinceMs)
    );
    return filtered.slice(-limit);
  }
}
