import net from 'net';
import { RelaySocket } from './http-relay.js';

// Local TCP port forwards through MeshCentral relays (what MeshCentral Router does):
// a listener on 127.0.0.1 whose every connection becomes its own relay to host:port
// on the device's network. Lets a browser (Playwright) or any local client reach a
// web UI or API behind an agent.
export class PortForwardManager {
  #client;
  #idleMs;
  #max;
  #forwards = new Map(); // id -> forward
  #seq = 0;

  constructor({ client, idleMinutes = 30, maxForwards = 5 }) {
    this.#client = client;
    this.#idleMs = idleMinutes * 60_000;
    this.#max = maxForwards;
  }

  list() {
    return [...this.#forwards.values()].map((f) => this.#describe(f));
  }

  get(id) {
    return this.#forwards.get(id) ?? null;
  }

  async open({ nodeId, nodeName, host, port, localPort = 0 }) {
    if (this.#forwards.size >= this.#max) throw new Error(`Already ${this.#max} port forwards open; close one first (mesh_port_forward_close).`);
    const id = `fwd${++this.#seq}`;
    const f = { id, nodeId, nodeName, host, port, server: null, sockets: new Set(), connections: 0, errors: 0, lastError: null, opened: Date.now(), lastUsed: Date.now(), idleTimer: null };

    f.server = net.createServer((local) => this.#accept(f, local));
    await new Promise((resolve, reject) => {
      f.server.once('error', reject);
      f.server.listen(localPort, '127.0.0.1', () => { f.server.off('error', reject); resolve(); });
    });
    f.server.on('error', () => {});
    f.localPort = f.server.address().port;
    this.#forwards.set(id, f);
    this.#touch(f);
    return this.#describe(f);
  }

  async #accept(f, local) {
    this.#touch(f);
    f.connections++;
    f.sockets.add(local);
    local.on('close', () => f.sockets.delete(local));
    local.on('error', () => {});
    local.pause();
    let remote;
    try {
      remote = new RelaySocket(await this.#client.openTcpRelay(f.nodeId, f.host, f.port));
    } catch (err) {
      f.errors++;
      f.lastError = err.message;
      local.destroy();
      return;
    }
    f.sockets.add(remote);
    remote.on('close', () => f.sockets.delete(remote));
    remote.on('error', (err) => { f.lastError = err.message; local.destroy(); });
    local.on('close', () => remote.destroy());
    remote.on('end', () => local.end());
    local.on('data', () => this.#touch(f));
    remote.on('data', () => this.#touch(f));
    local.pipe(remote);
    remote.pipe(local);
    local.resume();
  }

  #touch(f) {
    f.lastUsed = Date.now();
    clearTimeout(f.idleTimer);
    f.idleTimer = setTimeout(() => this.close(f.id), this.#idleMs);
    f.idleTimer.unref?.();
  }

  close(id) {
    const f = this.#forwards.get(id);
    if (!f) return false;
    this.#forwards.delete(id);
    clearTimeout(f.idleTimer);
    try { f.server.close(); } catch {}
    for (const s of f.sockets) { try { s.destroy(); } catch {} }
    return true;
  }

  closeAll() {
    for (const id of [...this.#forwards.keys()]) this.close(id);
  }

  #describe(f) {
    return {
      id: f.id, local: `127.0.0.1:${f.localPort}`, node: f.nodeName, nodeId: f.nodeId, target: `${f.host}:${f.port}`,
      connections: f.connections, open_connections: Math.floor(f.sockets.size / 2), errors: f.errors, lastError: f.lastError,
      idleMinutesLeft: Math.max(0, Math.round((f.lastUsed + this.#idleMs - Date.now()) / 60_000)),
    };
  }
}
