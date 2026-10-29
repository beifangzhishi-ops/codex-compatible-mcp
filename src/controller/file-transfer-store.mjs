import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FILE_TTL_MS = 72 * 60 * 60 * 1000;
export const MAX_FILE_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
export const FILE_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function valid(entry, token, now) {
  return entry && entry.token === token && FILE_TOKEN_RE.test(token) &&
    typeof entry.filename === 'string' && !!entry.filename &&
    typeof entry.mime_type === 'string' && !!entry.mime_type &&
    Number.isSafeInteger(entry.byte_length) && entry.byte_length >= 0 &&
    entry.byte_length <= MAX_FILE_BYTES &&
    Number.isFinite(entry.createdAt) && Number.isFinite(entry.expiresAt) &&
    entry.expiresAt === entry.createdAt + FILE_TTL_MS && entry.expiresAt > now &&
    !Object.hasOwn(entry, 'data');
}

export class FileTransferStore {
  constructor({ stateDir = null, maxTotalBytes = Number(process.env.CCM_FILE_TRANSFER_CACHE_BYTES || DEFAULT_MAX_TOTAL_BYTES), clock = Date.now } = {}) {
    this.ephemeral = !stateDir;
    this.stateDir = stateDir ? path.resolve(stateDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-files-'));
    this.maxTotalBytes = Number.isSafeInteger(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : DEFAULT_MAX_TOTAL_BYTES;
    this.clock = clock;
    this.entries = new Map();
    this.totalBytes = 0;
    this.active = new Map();
    this.pendingDelete = new Set();
    this.#load();
    this.timer = setInterval(() => this.#cleanup(), 60 * 60 * 1000);
    this.timer.unref();
  }

  #name(token, ext) { return path.join(this.stateDir, token + ext); }
  #unlink(token) {
    if (this.active.get(token)) { this.pendingDelete.add(token); return; }
    fs.rmSync(this.#name(token, '.bin'), { force: true });
  }
  #remove(token) {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    this.totalBytes -= entry.byte_length;
    fs.rmSync(this.#name(token, '.json'), { force: true });
    this.#unlink(token);
  }
  #cleanup() {
    const now = this.clock();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.#remove(token);
    }
  }
  #evict(byteLength) {
    this.#cleanup();
    while (this.entries.size && this.totalBytes + byteLength > this.maxTotalBytes) {
      this.#remove(this.entries.keys().next().value);
    }
  }
  #load() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    // Legacy cache files can have an ACL inherited from a different Worker
    // token. Reject them from the index even if physical removal is denied.
    const pruneLegacy = (file) => {
      try { fs.rmSync(file, { force: true }); }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      }
    };
    const entries = [];
    const referenced = new Set();
    for (const name of fs.readdirSync(this.stateDir)) {
      if (!name.endsWith('.json')) continue;
      const token = name.slice(0, -5);
      if (!FILE_TOKEN_RE.test(token)) continue;
      try {
        const entry = JSON.parse(fs.readFileSync(this.#name(token, '.json'), 'utf8'));
        const binary = fs.lstatSync(this.#name(token, '.bin'));
        if (!valid(entry, token, this.clock()) || !binary.isFile() || binary.size !== entry.byte_length) throw new Error('invalid');
        entries.push(Object.freeze(entry));
        referenced.add(token + '.bin');
      } catch {
        pruneLegacy(this.#name(token, '.json'));
      }
    }
    entries.sort((a, b) => a.createdAt - b.createdAt || a.token.localeCompare(b.token));
    for (const entry of entries) { this.entries.set(entry.token, entry); this.totalBytes += entry.byte_length; }
    for (const name of fs.readdirSync(this.stateDir)) {
      if ((name.endsWith('.bin') && !referenced.has(name)) || name.endsWith('.tmp')) pruneLegacy(path.join(this.stateDir, name));
    }
    this.#evict(0);
  }
  put(value, { environmentId } = {}) {
    if (!value?.filename || !value?.mime_type || typeof value.data !== 'string' || !Number.isSafeInteger(Number(value.byte_length))) throw new Error('Invalid file transfer.');
    const bytes = Buffer.from(value.data, 'base64');
    if (bytes.length !== Number(value.byte_length) || bytes.length > MAX_FILE_BYTES || bytes.length > this.maxTotalBytes) throw new Error('File size exceeds transfer limit or does not match metadata.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (/^[a-f0-9]{64}$/i.test(String(value.sha256)) && sha256.toLowerCase() !== value.sha256.toLowerCase()) throw new Error('File checksum mismatch.');
    const token = randomUUID();
    const now = this.clock();
    const entry = Object.freeze({ token, environment_id: environmentId || null, filename: String(value.filename), mime_type: String(value.mime_type), byte_length: bytes.length, sha256, createdAt: now, expiresAt: now + FILE_TTL_MS });
    const binTemp = this.#name(token, '.bin.tmp');
    const jsonTemp = this.#name(token, '.json.tmp');
    try {
      fs.writeFileSync(binTemp, bytes, { flag: 'wx' });
      fs.writeFileSync(jsonTemp, JSON.stringify(entry) + '\n', { flag: 'wx' });
      fs.renameSync(binTemp, this.#name(token, '.bin'));
      fs.renameSync(jsonTemp, this.#name(token, '.json'));
      this.#evict(bytes.length);
      this.entries.set(token, entry);
      this.totalBytes += bytes.length;
      return entry;
    } catch (error) {
      for (const name of [binTemp, jsonTemp, this.#name(token, '.bin'), this.#name(token, '.json')]) fs.rmSync(name, { force: true });
      throw error;
    }
  }
  get(token) {
    this.#cleanup();
    return FILE_TOKEN_RE.test(String(token)) ? this.entries.get(token) || null : null;
  }
  acquire(token, range = null) {
    const entry = this.get(token);
    if (!entry) return null;
    let fd;
    try {
      fd = fs.openSync(this.#name(token, '.bin'), 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== entry.byte_length) {
        fs.closeSync(fd);
        this.#remove(token);
        return null;
      }
    }
    catch { this.#remove(token); return null; }
    this.active.set(token, (this.active.get(token) || 0) + 1);
    let released = false;
    const streamOptions = { fd, autoClose: true };
    if (range) {
      streamOptions.start = range.start;
      streamOptions.end = range.end;
    }
    return { entry, stream: fs.createReadStream(null, streamOptions), release: () => {
      if (released) return;
      released = true;
      const count = (this.active.get(token) || 1) - 1;
      if (count) this.active.set(token, count); else this.active.delete(token);
      if (!count && this.pendingDelete.delete(token)) this.#unlink(token);
    } };
  }
  close() {
    clearInterval(this.timer);
    this.entries.clear();
    this.totalBytes = 0;
    if (this.ephemeral) fs.rmSync(this.stateDir, { recursive: true, force: true });
  }
}
