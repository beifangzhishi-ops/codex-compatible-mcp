import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TTL_MS = 0;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeTtl(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function validateEntry(value) {
  if (!value || !TOKEN_RE.test(String(value.token || ''))) return null;
  const byteLength = Number(value.byte_length);
  if (!value.filename || !value.mime_type || typeof value.data !== 'string' ||
      !Number.isFinite(byteLength) || byteLength < 0) {
    return null;
  }
  const createdAt = Number(value.createdAt);
  const expiresAt = value.expiresAt === null || value.expiresAt === undefined
    ? null
    : Number(value.expiresAt);
  if (!Number.isFinite(createdAt)) return null;
  if (expiresAt !== null && !Number.isFinite(expiresAt)) return null;
  const token = String(value.token);
  return Object.freeze({
    token,
    uri: 'ccm-file:///' + token,
    environment_id: value.environment_id || null,
    path: value.path || null,
    filename: String(value.filename),
    mime_type: String(value.mime_type),
    byte_length: byteLength,
    sha256: value.sha256 || null,
    data: value.data,
    createdAt,
    expiresAt,
  });
}

export class FileTransferStore {
  constructor({
    ttlMs = Number(process.env.CCM_FILE_TRANSFER_TTL_MS || DEFAULT_TTL_MS),
    maxTotalBytes = Number(
      process.env.CCM_FILE_TRANSFER_CACHE_BYTES || DEFAULT_MAX_TOTAL_BYTES,
    ),
    stateDir = null,
    clock = Date.now,
  } = {}) {
    this.ttlMs = normalizeTtl(ttlMs);
    this.maxTotalBytes = finitePositive(
      maxTotalBytes,
      DEFAULT_MAX_TOTAL_BYTES,
    );
    this.stateDir = stateDir ? path.resolve(stateDir) : null;
    this.clock = typeof clock === 'function' ? clock : Date.now;
    this.entries = new Map();
    this.totalBytes = 0;
    this.#load();
  }

  #entryPath(token) {
    if (!this.stateDir) return null;
    if (!TOKEN_RE.test(String(token || ''))) {
      throw new Error('Invalid file-transfer token.');
    }
    return path.join(this.stateDir, String(token) + '.json');
  }

  #load() {
    if (!this.stateDir || !fs.existsSync(this.stateDir)) return;
    const loaded = [];
    for (const name of fs.readdirSync(this.stateDir)) {
      if (!name.endsWith('.json')) continue;
      const token = name.slice(0, -5);
      if (!TOKEN_RE.test(token)) continue;
      const target = path.join(this.stateDir, name);
      try {
        const parsed = JSON.parse(
          fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''),
        );
        const entry = validateEntry(parsed);
        if (!entry || entry.token !== token) {
          fs.rmSync(target, { force: true });
          continue;
        }
        loaded.push(entry);
      } catch {
        fs.rmSync(target, { force: true });
      }
    }
    loaded.sort((a, b) => a.createdAt - b.createdAt);
    for (const entry of loaded) {
      this.entries.set(entry.token, entry);
      this.totalBytes += entry.byte_length;
    }
    this.#cleanup();
    this.#evictFor(0);
  }

  #persist(entry) {
    if (!this.stateDir) return;
    fs.mkdirSync(this.stateDir, { recursive: true });
    const target = this.#entryPath(entry.token);
    const temp = path.join(
      this.stateDir,
      '.' + entry.token + '.' + process.pid + '.' + randomUUID() + '.tmp',
    );
    try {
      fs.writeFileSync(
        temp,
        JSON.stringify(entry) + '\n',
        { encoding: 'utf8', flag: 'wx' },
      );
      fs.renameSync(temp, target);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      throw error;
    }
  }

  #remove(token) {
    const entry = this.entries.get(token);
    if (!entry) return;
    this.entries.delete(token);
    this.totalBytes -= entry.byte_length;
    if (this.stateDir) {
      fs.rmSync(this.#entryPath(token), { force: true });
    }
  }

  #cleanup(now = this.clock()) {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt === null || entry.expiresAt > now) continue;
      this.#remove(token);
    }
  }

  #evictFor(byteLength) {
    this.#cleanup();
    while (
      this.entries.size > 0 &&
      this.totalBytes + byteLength > this.maxTotalBytes
    ) {
      const oldestToken = this.entries.keys().next().value;
      this.#remove(oldestToken);
    }
  }

  put(value, { environmentId } = {}) {
    const byteLength = Number(value?.byte_length || 0);
    if (!value?.filename || !value?.mime_type || !value?.data || byteLength < 0) {
      throw new Error('FileTransferStore requires a complete encoded file value.');
    }
    if (byteLength > this.maxTotalBytes) {
      throw new Error(
        'file exceeds CCM file-transfer cache limit (' + byteLength + ' > ' +
        this.maxTotalBytes + ' bytes)',
      );
    }

    this.#evictFor(byteLength);
    const token = randomUUID();
    const now = this.clock();
    const entry = Object.freeze({
      token,
      uri: 'ccm-file:///' + token,
      environment_id: environmentId || null,
      path: value.path,
      filename: value.filename,
      mime_type: value.mime_type,
      byte_length: byteLength,
      sha256: value.sha256,
      data: value.data,
      createdAt: now,
      expiresAt: this.ttlMs > 0 ? now + this.ttlMs : null,
    });
    this.#persist(entry);
    this.entries.set(token, entry);
    this.totalBytes += byteLength;
    return entry;
  }

  get(token) {
    this.#cleanup();
    return this.entries.get(String(token || '')) || null;
  }

  close() {
    this.entries.clear();
    this.totalBytes = 0;
  }
}
