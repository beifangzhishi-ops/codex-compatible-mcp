import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeJsonAtomicSync } from './json-state.mjs';
import {
  effectiveShell,
  parseShellCommand,
  tokenPrefixMatches,
  validatePrefixTokens,
} from '../runtime/sandbox/shell-policy-parser.mjs';

const STATE_VERSION = 3;

function publicRule(rule) {
  return {
    rule_id: rule.rule_id,
    decision: rule.decision,
    prefix_tokens: [...rule.prefix_tokens],
    created_at: rule.created_at,
  };
}

export class ExecPolicyStore {
  constructor({ stateFile = null, audit = null, now = () => new Date() } = {}) {
    this.stateFile = stateFile || null;
    this.audit = typeof audit === 'function' ? audit : null;
    this.now = now;
    this.rules = [];
    this.#load();
  }

  #emit(event, fields = {}) {
    this.audit?.({ component: 'exec-policy', event, ...fields });
  }

  #load() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''));
      if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.rules)) {
        throw new Error('Unsupported execution allowlist version.');
      }
      this.rules = parsed.rules.filter((rule) =>
        rule?.rule_id &&
        rule?.decision === 'allow' &&
        typeof rule?.created_at === 'string' &&
        validatePrefixTokens(rule?.prefix_tokens));
    } catch (error) {
      this.#emit('load_failed', {
        error_name: error?.name || 'Error',
        error_message: String(error?.message || error),
      });
      this.rules = [];
    }
  }

  #persist() {
    if (this.stateFile) {
      writeJsonAtomicSync(this.stateFile, {
        version: STATE_VERSION,
        rules: this.rules,
      });
    }
  }

  // User-granted Allow rules are Controller-wide across Workers, workspaces,
  // working directories, effective shells and PTY settings.
  matchSegment({ environment, tokens, emit = true }) {
    const rule = this.rules.find((candidate) =>
      tokenPrefixMatches(candidate.prefix_tokens, tokens, {
        platform: environment?.platform || 'windows',
      }));
    if (!rule) return null;
    if (emit) this.#emit('matched', {
      rule_id: rule.rule_id,
      decision: rule.decision,
      prefix_tokens: rule.prefix_tokens,
    });
    return publicRule(rule);
  }

  match({ environment, args, parsed = null }) {
    const shell = effectiveShell(args, environment);
    const command = parsed || parseShellCommand(args.cmd, { shell });
    if (!command?.segments.length || command.operators.includes('|')) return null;
    const matches = [];
    for (const segment of command.segments) {
      const rule = this.matchSegment({
        environment,
        tokens: segment.tokens,
        emit: false,
      });
      if (!rule) return null;
      matches.push(rule);
    }
    const unique = [...new Map(matches.map((rule) => [rule.rule_id, rule])).values()];
    for (const rule of unique) {
      this.#emit('matched', {
        rule_id: rule.rule_id,
        decision: rule.decision,
        prefix_tokens: rule.prefix_tokens,
      });
    }
    return {
      decision: 'allow',
      rule_id: unique[0].rule_id,
      rule_ids: unique.map((rule) => rule.rule_id),
      prefix_tokens: unique.length === 1
        ? [...unique[0].prefix_tokens]
        : unique.map((rule) => [...rule.prefix_tokens]),
    };
  }

  allow({ prefixTokens }) {
    const normalizedPrefix = validatePrefixTokens(prefixTokens);
    if (!normalizedPrefix) {
      throw new Error('Persistent execution allowlist requires valid prefix tokens.');
    }
    const existing = this.rules.find((rule) =>
      rule.decision === 'allow' &&
      JSON.stringify(rule.prefix_tokens) === JSON.stringify(normalizedPrefix));
    if (existing) return publicRule(existing);
    const rule = {
      rule_id: crypto.randomUUID(),
      decision: 'allow',
      prefix_tokens: normalizedPrefix,
      created_at: this.now().toISOString(),
    };
    this.rules.push(rule);
    this.#persist();
    this.#emit('created', {
      rule_id: rule.rule_id,
      decision: rule.decision,
      prefix_tokens: rule.prefix_tokens,
    });
    return publicRule(rule);
  }

  list() {
    return this.rules.map(publicRule);
  }

  close() {
    this.#persist();
  }
}
