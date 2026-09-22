import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export class FileTransferStore {
  constructor({
    ttlMs = Number(process.env.CCM_FILE_TRANSFER_TTL_MS || DEFAULT_TTL_MS),
    maxTotalBytes = Number(
      process.env.CCM_FILE_TRANSFER_CACHE_BYTES || DEFAULT_MAX_TOTAL_BYTES,
    ),
  } = {}) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
    this.maxTotalBytes = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0
      ? maxTotalBytes
      : DEFAULT_MAX_TOTAL_BYTES;
    this.entries = new Map();
    this.totalBytes = 0;
  }

  #cleanup(now = Date.now()) {
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.entries.delete(token);
      this.totalBytes -= entry.byte_length;
    }
  }

  #evictFor(byteLength) {
    this.#cleanup();
    while (
      this.entries.size > 0 &&
      this.totalBytes + byteLength > this.maxTotalBytes
    ) {
      const oldestToken = this.entries.keys().next().value;
      const oldest = this.entries.get(oldestToken);
      this.entries.delete(oldestToken);
      this.totalBytes -= oldest?.byte_length || 0;
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
    const now = Date.now();
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
      expiresAt: now + this.ttlMs,
    });
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
