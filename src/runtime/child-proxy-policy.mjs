import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_STATE_FILE = fileURLToPath(
  new URL('../../.state/child-proxy.json', import.meta.url),
);
const VALID_MODES = new Set(['proxy', 'direct']);

export function defaultChildProxyStateFile() {
  return process.env.CCM_INSTALL_ROOT
    ? path.join(process.env.CCM_INSTALL_ROOT, '.state', 'child-proxy.json')
    : DEFAULT_STATE_FILE;
}

export function parseChildProxyPolicy(content) {
  let parsed;
  try {
    parsed = JSON.parse(String(content).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(
      'Invalid child proxy policy JSON: ' + String(error?.message || error),
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Child proxy policy must be a JSON object.');
  }
  if (!VALID_MODES.has(parsed.mode)) {
    throw new Error('Child proxy policy mode must be proxy or direct.');
  }
  return { mode: parsed.mode };
}

export class ChildProxyPolicy {
  constructor({
    file = defaultChildProxyStateFile(),
    log = (level, message) => {
      if (level === 'error') console.error(message);
      else console.log(message);
    },
  } = {}) {
    this.file = path.resolve(file);
    this.log = log;
    this.mode = 'proxy';
    this.lastInvalidContent = null;
  }

  getMode() {
    let content;
    try {
      content = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.mode = 'proxy';
        this.lastInvalidContent = null;
        return this.mode;
      }
      throw error;
    }

    try {
      const next = parseChildProxyPolicy(content);
      this.mode = next.mode;
      this.lastInvalidContent = null;
      return this.mode;
    } catch (error) {
      if (content !== this.lastInvalidContent) {
        this.lastInvalidContent = content;
        this.log(
          'error',
          'Child proxy policy reload failed; keeping last known-good mode ' +
            this.mode + ': ' + String(error?.message || error),
        );
      }
      return this.mode;
    }
  }
}

export const childProxyPolicyInternals = {
  VALID_MODES,
};
