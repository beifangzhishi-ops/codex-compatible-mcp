import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applySingleFilePatchToText } from '../runtime/filesystem/apply-patch.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_READ_LINES = 400;
const MAX_READ_CHARS = 32_000;
const MAX_SEARCH_MATCHES = 20;
const SEARCH_CONTEXT_LINES = 2;
const MAX_SEARCH_LINE_CHARS = 1_000;

function assertPlanId(planId) {
  if (!UUID_RE.test(String(planId || ''))) {
    throw new Error('Invalid plan_id.');
  }
  return String(planId);
}

function splitLines(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

function boundedSlice(lines, requestedStart, requestedEnd) {
  const totalLines = lines.length;
  const start = Math.max(1, requestedStart || 1);
  if (start > totalLines) {
    throw new Error(
      'start_line ' + start + ' exceeds Plan length (' + totalLines + ' lines).',
    );
  }
  const desiredEnd = Math.min(
    totalLines,
    requestedEnd || (start + MAX_READ_LINES - 1),
    start + MAX_READ_LINES - 1,
  );
  const selected = [];
  let chars = 0;
  let lineNumber = start;
  let lineTruncated = false;
  for (; lineNumber <= desiredEnd; lineNumber += 1) {
    const value = lines[lineNumber - 1] ?? '';
    const extra = value.length + (selected.length ? 1 : 0);
    if (chars + extra > MAX_READ_CHARS) {
      if (selected.length === 0) {
        selected.push(value.slice(0, MAX_READ_CHARS));
        lineTruncated = value.length > MAX_READ_CHARS;
      }
      break;
    }
    selected.push(value);
    chars += extra;
  }
  const endLine = selected.length ? start + selected.length - 1 : Math.min(start, totalLines);
  const truncated = endLine < totalLines && endLine < (requestedEnd || totalLines);
  return {
    start_line: start,
    end_line: endLine,
    total_lines: totalLines,
    content: selected.join('\n'),
    truncated: truncated || lineTruncated,
    ...(lineTruncated ? { line_truncated: true } : {}),
    ...(truncated ? { next_start_line: endLine + 1 } : {}),
  };
}

function clippedLine(value) {
  const text = String(value);
  if (text.length <= MAX_SEARCH_LINE_CHARS) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, MAX_SEARCH_LINE_CHARS) + '…',
    truncated: true,
  };
}

export class PlanManager {
  constructor({ stateDir } = {}) {
    if (!stateDir) throw new Error('PlanManager requires stateDir.');
    this.stateDir = path.resolve(stateDir);
    this.writeChains = new Map();
  }

  #planPath(planId) {
    return path.join(this.stateDir, assertPlanId(planId) + '.md');
  }

  async #serialize(planId, action) {
    const prior = this.writeChains.get(planId) || Promise.resolve();
    const run = prior.catch(() => {}).then(action);
    const settled = run.catch(() => {});
    this.writeChains.set(planId, settled);
    try {
      return await run;
    } finally {
      if (this.writeChains.get(planId) === settled) {
        this.writeChains.delete(planId);
      }
    }
  }

  async #atomicWrite(target, content) {
    await fs.mkdir(this.stateDir, { recursive: true });
    const temp = path.join(
      this.stateDir,
      '.' + path.basename(target) + '.' + process.pid + '.' + randomUUID() + '.tmp',
    );
    try {
      await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  async create(patch) {
    const content = applySingleFilePatchToText({
      patch,
      targetPath: 'plan.md',
      mode: 'add',
    });
    const planId = randomUUID();
    const target = this.#planPath(planId);
    await this.#serialize(planId, () => this.#atomicWrite(target, content));
    return {
      plan_id: planId,
      created: true,
      byte_length: Buffer.byteLength(content, 'utf8'),
    };
  }

  async patch(planId, patch) {
    const id = assertPlanId(planId);
    const target = this.#planPath(id);
    return this.#serialize(id, async () => {
      let current;
      try {
        current = await fs.readFile(target, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error('Unknown plan_id: ' + id);
        throw error;
      }
      const content = applySingleFilePatchToText({
        patch,
        currentText: current,
        targetPath: 'plan.md',
        mode: 'update',
      });
      await this.#atomicWrite(target, content);
      return {
        plan_id: id,
        created: false,
        byte_length: Buffer.byteLength(content, 'utf8'),
      };
    });
  }

  async read(planId, { startLine, endLine, query } = {}) {
    const id = assertPlanId(planId);
    const target = this.#planPath(id);
    let text;
    try {
      text = await fs.readFile(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('Unknown plan_id: ' + id);
      throw error;
    }
    const lines = splitLines(text);
    if (query != null) {
      const needle = String(query).toLowerCase();
      const allMatchLines = [];
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].toLowerCase().includes(needle)) {
          allMatchLines.push(index + 1);
        }
      }
      const matches = allMatchLines.slice(0, MAX_SEARCH_MATCHES).map((lineNumber) => {
        const contextStart = Math.max(1, lineNumber - SEARCH_CONTEXT_LINES);
        const contextEnd = Math.min(lines.length, lineNumber + SEARCH_CONTEXT_LINES);
        const matchText = clippedLine(lines[lineNumber - 1]);
        return {
          line: lineNumber,
          text: matchText.text,
          ...(matchText.truncated ? { text_truncated: true } : {}),
          context: Array.from(
            { length: contextEnd - contextStart + 1 },
            (_, offset) => {
              const line = contextStart + offset;
              const clipped = clippedLine(lines[line - 1]);
              return {
                line,
                text: clipped.text,
                ...(clipped.truncated ? { text_truncated: true } : {}),
              };
            },
          ),
        };
      });
      return {
        plan_id: id,
        mode: 'search',
        query: String(query),
        total_lines: lines.length,
        total_matches: allMatchLines.length,
        matches,
        truncated: allMatchLines.length > matches.length,
      };
    }

    const range = boundedSlice(lines, startLine, endLine);
    return {
      plan_id: id,
      mode: startLine != null || endLine != null ? 'range' : 'full',
      ...range,
    };
  }

  async close() {
    await Promise.allSettled([...this.writeChains.values()]);
    this.writeChains.clear();
  }
}
