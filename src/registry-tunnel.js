// MeshCentral remote registry (MeshCentral 1.3.0+, Windows agents only), spoken over
// a relay opened with protocol 4. Every request carries a reqid; the agent answers
// with the same action and reqid, plus `error` on failure.

export const HIVES = ['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER', 'HKEY_USERS', 'HKEY_CLASSES_ROOT', 'HKEY_CURRENT_CONFIG'];

const HIVE_ALIASES = {
  HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER', HKU: 'HKEY_USERS', HKCR: 'HKEY_CLASSES_ROOT', HKCC: 'HKEY_CURRENT_CONFIG',
};

export const VALUE_TYPES = ['REG_SZ', 'REG_EXPAND_SZ', 'REG_MULTI_SZ', 'REG_DWORD', 'REG_QWORD', 'REG_BINARY', 'REG_NONE'];

// Accepts "HKLM\\Software\\X", "HKEY_LOCAL_MACHINE\\Software\\X" or "HKLM:\\Software\\X"
// (PowerShell drive form). Returns { hive, path } with the path relative to the hive.
export function parseRegistryPath(full) {
  if (typeof full !== 'string' || !full.trim()) throw new Error('A registry path is required, e.g. HKLM\\SOFTWARE\\Microsoft');
  const parts = full.trim().replace(/\//g, '\\').split('\\').filter((p) => p !== '');
  const head = parts.shift().replace(/:$/, '').toUpperCase();
  const hive = HIVE_ALIASES[head] ?? (HIVES.includes(head) ? head : null);
  if (!hive) throw new Error(`Unknown registry hive "${head}". Use one of: ${Object.keys(HIVE_ALIASES).join(', ')} (or the full HKEY_ names).`);
  return { hive, path: parts.join('\\') };
}

export function joinRegistryPath(hive, path) {
  return path ? `${hive}\\${path}` : hive;
}

export class RegistryTunnel {
  #ws;
  #reqId = 0;
  #pending = new Map(); // reqid -> { resolve, reject, timer }
  #closed = false;

  constructor(ws) {
    this.#ws = ws;
    ws.on('message', (data) => this.#onData(data));
    ws.on('close', () => this.#onClose());
    ws.on('error', () => {});
  }

  get isOpen() {
    return !this.#closed && this.#ws.readyState === 1;
  }

  #onClose() {
    this.#closed = true;
    const err = new Error('Registry tunnel closed (agent too old for remote registry, not Windows, consent refused, or no remote-control right)');
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.#pending.clear();
  }

  #onData(data) {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    if (!text.startsWith('{')) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const p = msg.reqid != null && this.#pending.get(msg.reqid);
    if (!p) return;
    this.#pending.delete(msg.reqid);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(String(msg.error)));
    else p.resolve(msg);
  }

  #request(cmd, timeoutMs = 30_000) {
    if (!this.isOpen) return Promise.reject(new Error('Registry tunnel is closed'));
    const reqid = `rg_${++this.#reqId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(reqid);
        reject(new Error(`Registry '${cmd.action}' timed out (no answer from the agent; older agent cores do not support remote registry)`));
      }, timeoutMs);
      this.#pending.set(reqid, { resolve, reject, timer });
      try { this.#ws.send(JSON.stringify({ ...cmd, reqid })); } catch (err) { clearTimeout(timer); this.#pending.delete(reqid); reject(err); }
    });
  }

  async roots() {
    return (await this.#request({ action: 'listroots' })).roots ?? [];
  }

  // { subkeys: [name], values: [{ name, rawname, type, value }] }. The agent runs
  // reg.exe once per value to learn its type, so keys with many values are slow.
  async list(hive, path, timeoutMs = 60_000) {
    const r = await this.#request({ action: 'list', hive, path: path ?? '' }, timeoutMs);
    return { subkeys: r.subkeys ?? [], values: r.values ?? [] };
  }

  // .reg text (as written by `reg export`).
  async export(hive, path, timeoutMs = 120_000) {
    return (await this.#request({ action: 'export', hive, path }, timeoutMs)).content ?? '';
  }

  async setValue(hive, path, name, type, value) {
    await this.#request({ action: 'setvalue', hive, path: path ?? '', name: name ?? '', type, value });
  }

  async createKey(hive, path, name) {
    await this.#request({ action: 'createkey', hive, path: path ?? '', name });
  }

  // items: [{ kind: 'key' | 'value', hive, path, name }]; a key item names a subkey of `path`.
  async delete(items) {
    await this.#request({ action: 'delete', items });
  }

  async rename(item, newName) {
    await this.#request({ action: 'rename', item, newName });
  }

  close() {
    this.#closed = true;
    try { this.#ws.close(); } catch {}
  }
}
