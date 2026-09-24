import fs from 'node:fs';

function normalizeErrorCodes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Worker quarantine policy must be a JSON object.');
  }
  if (!Array.isArray(value.error_codes)) {
    throw new Error('Worker quarantine policy requires error_codes array.');
  }
  const codes = [];
  const seen = new Set();
  for (const entry of value.error_codes) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(
        'Worker quarantine policy error_codes must contain non-empty strings.',
      );
    }
    const code = entry.trim();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return codes;
}

export function parseWorkerQuarantinePolicy(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(
      'Invalid worker quarantine policy JSON: ' +
      String(error?.message || error),
    );
  }
  return normalizeErrorCodes(parsed);
}

export class WorkerQuarantinePolicy {
  constructor({
    file,
    pollIntervalMs = 1000,
    log = (level, message) => {
      if (level === 'error') console.error(message);
      else console.log(message);
    },
  } = {}) {
    if (!file) throw new Error('Worker quarantine policy file is required.');
    this.file = file;
    this.pollIntervalMs = Number(pollIntervalMs);
    this.log = log;
    this.errorCodes = new Set(this.#load());
    this.watching = false;
    this.watchListener = null;
  }

  list() {
    return [...this.errorCodes];
  }

  has(code) {
    return typeof code === 'string' && this.errorCodes.has(code);
  }

  start() {
    if (this.watching) return;
    this.watching = true;
    this.watchListener = (current, previous) => {
      if (
        current.mtimeMs === previous.mtimeMs &&
        current.size === previous.size
      ) {
        return;
      }
      try {
        const next = this.#load();
        this.errorCodes = new Set(next);
        this.log(
          'info',
          'Reloaded worker quarantine policy: ' +
          (next.length > 0 ? next.join(', ') : '(empty)'),
        );
      } catch (error) {
        this.log(
          'error',
          'Worker quarantine policy reload failed; keeping last known-good policy: ' +
          String(error?.message || error),
        );
      }
    };
    fs.watchFile(
      this.file,
      { interval: this.pollIntervalMs },
      this.watchListener,
    );
  }

  close() {
    if (!this.watching) return;
    fs.unwatchFile(this.file, this.watchListener);
    this.watchListener = null;
    this.watching = false;
  }

  #load() {
    return parseWorkerQuarantinePolicy(fs.readFileSync(this.file, 'utf8'));
  }
}
