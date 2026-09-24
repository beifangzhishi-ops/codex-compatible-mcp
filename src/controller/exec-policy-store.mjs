import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeJsonAtomicSync } from './json-state.mjs';
import {
  effectiveShell,
  normalizeWorkdir,
  parseShellCommand,
  tokenPrefixMatches,
  validatePrefixTokens,
} from '../runtime/sandbox/shell-policy-parser.mjs';

const STATE_VERSION = 2;

function publicRule(rule) {
  return {
    rule_id: rule.rule_id,
    decision: rule.decision,
    environment_id: rule.environment_id,
    workspace_id: rule.workspace_id,
    workspace_root: rule.workspace_root,
    prefix_tokens: [...rule.prefix_tokens],
    workdir: rule.workdir,
    tty: rule.tty,
    shell: rule.shell,
    created_at: rule.created_at,
  };
}

function sameScope(rule, { workspaceContext, environment, args }) {
  return rule.environment_id === String(environment.id) &&
    rule.workspace_id === String(workspaceContext.workspace_id) &&
    rule.workspace_root === String(workspaceContext.workspace_root) &&
    rule.workdir === normalizeWorkdir(args.workdir) &&
    rule.shell === effectiveShell(args, environment) &&
    Boolean(rule.tty) === Boolean(args.tty);
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
    if (!this.audit) return;
    this.audit({ component: 'exec-policy', event, ...fields });
  }

  #load() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''),
      );
      if (parsed?.version !== STATE_VERSION) {
        this.rules = [];
        this.#emit('legacy_state_reset', { previous_version: parsed?.version });
        this.#persist();
        return;
      }
      this.rules = Array.isArray(parsed.rules)
        ? parsed.rules.filter((rule) => (
          rule?.rule_id &&
          rule?.decision === 'allow' &&
          rule?.environment_id &&
          rule?.workspace_id &&
          rule?.workspace_root &&
          validatePrefixTokens(rule?.prefix_tokens)
        ))
        : [];
    } catch (error) {
      this.#emit('load_failed', {
        error_name: error?.name || 'Error',
        error_message: String(error?.message || error),
      });
      this.rules = [];
    }
  }

  #persist() {
    if (!this.stateFile) return;
    writeJsonAtomicSync(
      this.stateFile,
      { version: STATE_VERSION, rules: this.rules },
    );
  }

  match({ workspaceContext, environment, args, parsed = null }) {
    const shell = effectiveShell(args, environment);
    const command = parsed || parseShellCommand(args.cmd, { shell });
    if (!command?.segments.length) return null;

    const matched = [];
    for (const segment of command.segments) {
      const rule = this.matchSegment({
        workspaceContext,
        environment,
        args,
        tokens: segment.tokens,
        emit: false,
      });
      if (!rule) return null;
      matched.push(rule);
    }
    const unique = [...new Map(matched.map((rule) => [rule.rule_id, rule])).values()];
    for (const rule of unique) {
      this.#emit('matched', {
        rule_id: rule.rule_id,
        decision: rule.decision,
        environment_id: rule.environment_id,
        workspace_id: rule.workspace_id,
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

  matchSegment({ workspaceContext, environment, args, tokens, emit = true }) {
    const rule = this.rules.find((candidate) =>
      sameScope(candidate, { workspaceContext, environment, args }) &&
      tokenPrefixMatches(candidate.prefix_tokens, tokens, {
        platform: environment.platform || 'windows',
      }));
    if (!rule) return null;
    if (emit) {
      this.#emit('matched', {
        rule_id: rule.rule_id,
        decision: rule.decision,
        environment_id: rule.environment_id,
        workspace_id: rule.workspace_id,
        prefix_tokens: rule.prefix_tokens,
      });
    }
    return publicRule(rule);
  }

  allow({ workspaceContext, environment, args, prefixTokens }) {
    const normalizedPrefix = validatePrefixTokens(prefixTokens);
    if (!normalizedPrefix) {
      throw new Error('Persistent execution policy requires valid prefix tokens.');
    }
    const candidate = {
      decision: 'allow',
      environment_id: String(environment.id),
      workspace_id: String(workspaceContext.workspace_id),
      workspace_root: String(workspaceContext.workspace_root),
      prefix_tokens: normalizedPrefix,
      workdir: normalizeWorkdir(args.workdir),
      tty: Boolean(args.tty),
      shell: effectiveShell(args, environment),
    };
    const existing = this.rules.find((rule) => (
      rule.decision === candidate.decision &&
      rule.environment_id === candidate.environment_id &&
      rule.workspace_id === candidate.workspace_id &&
      rule.workspace_root === candidate.workspace_root &&
      JSON.stringify(rule.prefix_tokens) === JSON.stringify(candidate.prefix_tokens) &&
      rule.workdir === candidate.workdir &&
      Boolean(rule.tty) === candidate.tty &&
      rule.shell === candidate.shell
    ));
    if (existing) return publicRule(existing);

    const rule = {
      rule_id: crypto.randomUUID(),
      ...candidate,
      created_at: this.now().toISOString(),
    };
    this.rules.push(rule);
    this.#persist();
    this.#emit('created', {
      rule_id: rule.rule_id,
      decision: rule.decision,
      environment_id: rule.environment_id,
      workspace_id: rule.workspace_id,
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

export { STATE_VERSION as EXEC_POLICY_STATE_VERSION };
