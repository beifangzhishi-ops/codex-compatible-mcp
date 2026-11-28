import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const MAX_GLOBAL_RULES_LENGTH = 4000;
const identity = "CCM provides MCP tools for connected computers and project workflows. The Host chooses and sequences peer tools; use each tool's description for task-specific routing and invocation.";
const defaults = fs.readFileSync(new URL('./default-global-rules.txt', import.meta.url), 'utf8').trim();

function normalize(value) {
  if (typeof value !== 'string' || value.includes('\0') || value.length > MAX_GLOBAL_RULES_LENGTH) {
    throw new Error('Invalid global rules (maximum 4000 characters, no NUL).');
  }
  return value.replace(/\r\n?/g, '\n').trim();
}

export class GlobalRules {
  constructor({ stateFile = null } = {}) {
    this.stateFile = stateFile;
    this.value = defaults;
    if (stateFile) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      try {
        fs.writeFileSync(stateFile, defaults, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
  }

  read() {
    const text = this.stateFile ? normalize(fs.readFileSync(this.stateFile, 'utf8')) : this.value;
    return { text, revision: createHash('sha256').update(text).digest('hex') };
  }

  instructions() {
    const { text } = this.read();
    return text ? identity + '\n' + text : identity;
  }

  save(value, revision) {
    const text = normalize(value);
    if (this.read().revision !== revision) throw new Error('Global rules changed; reload before saving.');
    if (this.stateFile) {
      const temporary = this.stateFile + '.' + randomUUID() + '.tmp';
      try {
        fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, this.stateFile);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    } else {
      this.value = text;
    }
    return this.read();
  }
}
