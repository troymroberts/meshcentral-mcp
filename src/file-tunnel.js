import crypto from 'crypto';
import path from 'path';

const BLOCK_LAST = 0x01000001;
const DATA_BLOCK_SIZE = 16380;

// ── Remote path helpers ─────────────────────────────────────────────────
// The MCP server's own OS must not decide how a *remote* path is split.
export function isWindowsPath(p) {
  return /^[A-Za-z]:/.test(p) || p.includes('\\');
}

export function remotePath(p) {
  return isWindowsPath(p) ? path.win32 : path.posix;
}

export function splitRemotePath(p) {
  const impl = remotePath(p);
  const trimmed = p.length > 1 && /[\\/]$/.test(p) && !/^[A-Za-z]:[\\/]$/.test(p) ? p.slice(0, -1) : p;
  return { dir: impl.dirname(trimmed), name: impl.basename(trimmed) };
}

export function joinRemotePath(dir, name) {
  return remotePath(dir).join(dir, name);
}

// Implements MeshCentral's remote file protocol over a relay opened with protocol 5.
export class FileTunnel {
  #ws;
  #reqId = 0;
  #pending = new Map(); // reqid -> { resolve, reject, timer, accept: Set<action> }
  #downloadState = null;
  #findState = null;
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
    const err = new Error('File tunnel closed');
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.#pending.clear();
    if (this.#downloadState) {
      clearTimeout(this.#downloadState.timer);
      this.#downloadState.reject(new Error('Tunnel closed during download'));
      this.#downloadState = null;
    }
    if (this.#findState) {
      clearTimeout(this.#findState.timer);
      this.#findState.resolve(this.#findState.results);
      this.#findState = null;
    }
  }

  #onData(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length > 0 && buf[0] === 123) { // '{'
      let msg;
      try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
      this.#onJson(msg);
    } else if (this.#downloadState) {
      this.#onDownloadBlock(buf);
    }
  }

  #onJson(msg) {
    // A write failure mid-upload is reported without a reqid; route it to the active upload.
    if (msg.action === 'uploaderror' && msg.reqid == null) {
      const upload = [...this.#pending.keys()].find((k) => String(k).startsWith('up_'));
      if (upload) msg = { ...msg, reqid: upload };
    }
    if (msg.reqid != null && this.#pending.has(msg.reqid)) {
      const p = this.#pending.get(msg.reqid);
      if (!p.accept || p.accept.has(msg.action)) {
        this.#pending.delete(msg.reqid);
        clearTimeout(p.timer);
        p.resolve(msg);
        return;
      }
    }

    const dl = this.#downloadState;
    if (dl && msg.id === dl.id && msg.action === 'download') {
      if (msg.sub === 'start') {
        this.#sendJson({ action: 'download', sub: 'startack', id: dl.id, ack: 4 });
      } else if (msg.sub === 'cancel') {
        clearTimeout(dl.timer);
        this.#downloadState = null;
        dl.reject(new Error('Download cancelled by the agent (file not found, not readable, or busy)'));
      }
      return;
    }

    const fs = this.#findState;
    if (fs && msg.action === 'findfile' && msg.reqid === fs.reqid) {
      if (msg.r == null) {
        clearTimeout(fs.timer);
        this.#findState = null;
        fs.resolve(fs.results);
      } else {
        fs.results.push(msg.r);
      }
    }
  }

  #onDownloadBlock(buf) {
    const state = this.#downloadState;
    if (buf.length < 4) return;
    const header = buf.readInt32BE(0);
    state.chunks.push(buf.subarray(4));
    state.size += buf.length - 4;
    if (state.size > state.maxBytes) {
      clearTimeout(state.timer);
      this.#downloadState = null;
      try { this.#sendJson({ action: 'download', sub: 'stop', id: state.id }); } catch {}
      state.reject(new Error(`File exceeds the ${state.maxBytes}-byte limit`));
      return;
    }
    if (header === BLOCK_LAST) {
      clearTimeout(state.timer);
      this.#downloadState = null;
      state.resolve(Buffer.concat(state.chunks));
    } else {
      this.#sendJson({ action: 'download', sub: 'ack', id: state.id });
    }
  }

  #sendJson(obj) {
    if (!this.isOpen) throw new Error('File tunnel is closed');
    this.#ws.send(JSON.stringify(obj));
  }

  #request(cmd, { timeoutMs = 15_000, reqid = `ft_${++this.#reqId}`, accept = null, send = true } = {}) {
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, accept: accept && new Set(accept) };
      p.timer = setTimeout(() => {
        this.#pending.delete(reqid);
        reject(new Error(`File operation '${cmd.action}' timed out`));
      }, timeoutMs);
      this.#pending.set(reqid, p);
      if (send) {
        try { this.#sendJson({ ...cmd, reqid }); } catch (err) { clearTimeout(p.timer); this.#pending.delete(reqid); reject(err); }
      }
    });
  }

  // ── Public operations ─────────────────────────────────────────────────

  async list(dirPath, timeoutMs = 15_000) {
    const resp = await this.#request({ action: 'ls', path: dirPath }, { timeoutMs });
    if (resp.dir == null) throw new Error(`Path not found or inaccessible: ${dirPath}`);
    return resp.dir;
  }

  // Look up one entry by name in its parent directory; null when absent.
  async stat(fullPath) {
    const { dir, name } = splitRemotePath(fullPath);
    const entries = await this.list(dir);
    const nameCmp = isWindowsPath(fullPath) ? (a) => a.toLowerCase() === name.toLowerCase() : (a) => a === name;
    return entries.find((e) => nameCmp(e.n)) ?? null;
  }

  // The agent does not acknowledge these; callers verify with list()/stat().
  mkdir(dirPath) { this.#sendJson({ action: 'mkdir', path: dirPath }); }
  delete(dirPath, names, recursive = false) { this.#sendJson({ action: 'rm', path: dirPath, delfiles: names, rec: recursive }); }
  rename(dirPath, oldname, newname) { this.#sendJson({ action: 'rename', path: dirPath, oldname, newname }); }
  copy(scpath, dspath, names) { this.#sendJson({ action: 'copy', scpath, dspath, names }); }
  move(scpath, dspath, names) { this.#sendJson({ action: 'move', scpath, dspath, names }); }

  async download(filePath, { maxBytes = Infinity, timeoutMs = 120_000 } = {}) {
    if (this.#downloadState) throw new Error('Another download is in progress');
    const id = crypto.randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const state = { id, chunks: [], size: 0, maxBytes, resolve, reject };
      state.timer = setTimeout(() => {
        try { this.#sendJson({ action: 'download', sub: 'stop', id }); } catch {}
        this.#downloadState = null;
        reject(new Error('Download timed out'));
      }, timeoutMs);
      this.#downloadState = state;
      try {
        this.#sendJson({ action: 'download', sub: 'start', path: filePath, id });
      } catch (err) {
        clearTimeout(state.timer);
        this.#downloadState = null;
        reject(err);
      }
    });
  }

  async upload(dirPath, name, data, timeoutMs = 120_000) {
    const reqid = `up_${++this.#reqId}`;
    const replies = ['uploadstart', 'uploadack', 'uploaddone', 'uploaderror'];
    const start = await this.#request({ action: 'upload', path: dirPath, name, size: data.length }, { timeoutMs, reqid, accept: replies });
    if (start.action === 'uploaderror') throw new Error('Upload rejected by the remote device (path missing or not writable?)');

    for (let offset = 0; offset < data.length; offset += DATA_BLOCK_SIZE) {
      const block = data.subarray(offset, offset + DATA_BLOCK_SIZE);
      const ack = this.#request(null, { timeoutMs, reqid, accept: replies, send: false });
      this.#ws.send(Buffer.concat([Buffer.from([0]), block])); // 0x00 prefix escapes binary from JSON
      const r = await ack;
      if (r.action === 'uploaderror') throw new Error('Write failed on the remote device');
    }

    const done = this.#request({ action: 'uploaddone' }, { timeoutMs, reqid, accept: ['uploaddone', 'uploaderror'] });
    const r = await done;
    if (r.action === 'uploaderror') throw new Error('Upload failed to complete on the remote device');
  }

  async find(dirPath, filter, timeoutMs = 20_000) {
    if (this.#findState) throw new Error('Another search is in progress');
    const reqid = `find_${++this.#reqId}`;
    return new Promise((resolve) => {
      const state = { reqid, results: [], resolve };
      state.timer = setTimeout(() => { this.#findState = null; resolve(state.results); }, timeoutMs);
      this.#findState = state;
      this.#sendJson({ action: 'findfile', path: dirPath, filter, reqid });
    });
  }

  close() {
    if (this.#downloadState) {
      try { this.#sendJson({ action: 'download', sub: 'stop', id: this.#downloadState.id }); } catch {}
    }
    this.#closed = true;
    try { this.#ws.close(); } catch {}
  }
}
