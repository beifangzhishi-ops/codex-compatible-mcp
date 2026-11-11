import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultControllerStateFile } from './controller-state.mjs';
import { validatePrefixTokens } from '../runtime/sandbox/shell-policy-parser.mjs';

// The parser, matcher, precedence and persistence are all provided by the
// unmodified upstream Rust codex-execpolicy library. This module only sends
// commands to its JSON-lines transport adapter.
export const DEFAULT_RULES_FILE = defaultControllerStateFile('rules/default.rules');
export const DEFAULT_POLICY_BINARY = fileURLToPath(new URL(
  '../../native/bin/' + (process.platform === 'win32'
    ? 'ccm-codex-execpolicy-bridge.exe' : 'ccm-codex-execpolicy-bridge'),
  import.meta.url,
));

export class CodexExecPolicy {
  constructor({ stateFile = DEFAULT_RULES_FILE, binary = DEFAULT_POLICY_BINARY, audit = null } = {}) {
    this.stateFile = path.resolve(stateFile);
    this.binary = path.resolve(binary);
    this.audit = typeof audit === 'function' ? audit : null;
    if (!fs.existsSync(this.binary)) {
      throw new Error('Native Codex ExecPolicy bridge is missing: ' + this.binary);
    }
  }

  #run(request) {
    const process = spawnSync(this.binary, [], {
      input: JSON.stringify(request) + '\n',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    if (process.error || process.status !== 0) {
      throw new Error('Native Codex ExecPolicy failed: ' +
        String(process.error?.message || process.stderr || process.status));
    }
    let reply;
    try {
      reply = JSON.parse(process.stdout.trim());
    } catch {
      throw new Error('Native Codex ExecPolicy returned invalid JSON.');
    }
    if (!reply?.ok) throw new Error('Native Codex ExecPolicy: ' + String(reply?.error || 'unknown error'));
    return reply.result;
  }

  matchSegment({ tokens, emit = true }) {
    if (!validatePrefixTokens(tokens)) return null;
    const result = this.#run({
      op: 'check',
      rules: fs.existsSync(this.stateFile) ? [this.stateFile] : [],
      tokens,
      resolve_host_executables: true,
    });
    if (!result?.decision) return null;
    const matches = result.matchedRules || [];
    const prefixes = matches.map((match) => match.prefixRuleMatch?.matchedPrefix)
      .filter(Array.isArray);
    const ruleIds = prefixes.map((prefix) =>
      crypto.createHash('sha256').update(JSON.stringify(prefix)).digest('hex').slice(0, 16));
    if (emit) this.audit?.({ component: 'codex-execpolicy', event: 'matched',
      decision: result.decision, rule_ids: ruleIds });
    return {
      decision: result.decision,
      rule_id: ruleIds[0] || null,
      rule_ids: ruleIds,
      prefix_tokens: prefixes[0] || tokens,
    };
  }

  match({ parsed, emit = true }) {
    if (!parsed?.segments?.length) return null;
    const results = parsed.segments.map((segment) =>
      this.matchSegment({ tokens: segment.tokens, emit: false }));
    const prohibited = results.find((result) => result?.decision === 'forbidden');
    const prompted = results.find((result) => result?.decision === 'prompt');
    const allowed = results.every((result) => result?.decision === 'allow');
    const decision = prohibited ? 'forbidden' : prompted ? 'prompt' : allowed ? 'allow' : null;
    if (!decision) return null;
    const matching = results.filter(Boolean);
    const unique = [...new Map(matching.map((result) =>
      [result.rule_id || JSON.stringify(result.prefix_tokens), result])).values()];
    const ruleIds = [...new Set(unique.flatMap((rule) => rule.rule_ids))];
    const prefixes = unique.map((rule) => rule.prefix_tokens);
    if (emit) this.audit?.({ component: 'codex-execpolicy', event: 'matched',
      decision, rule_ids: ruleIds });
    return {
      decision,
      rule_id: ruleIds[0] || null,
      rule_ids: ruleIds,
      prefix_tokens: prefixes.length === 1 ? prefixes[0] : prefixes,
    };
  }

  allow({ prefixTokens }) {
    const prefix = validatePrefixTokens(prefixTokens);
    if (!prefix) throw new Error('Native Codex policy requires valid command-prefix tokens.');
    this.#run({ op: 'append_allow', path: this.stateFile, prefix });
    const rule = this.matchSegment({ tokens: prefix });
    if (rule?.decision !== 'allow') {
      throw new Error('Native Codex policy did not authorize the saved prefix.');
    }
    return rule;
  }
}
