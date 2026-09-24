import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  effectiveShell,
  normalizeWorkdir,
} from '../runtime/sandbox/shell-policy-parser.mjs';
import { writeJsonAtomicSync } from './json-state.mjs';
import { parsePackageScriptCommand } from './package-script-policy.mjs';

function normalizeCommand(value) {
  return String(value || '').trim();
}

function publicRule(rule) {
  return {
    rule_id: rule.rule_id,
    environment_id: rule.environment_id,
    workspace_id: rule.workspace_id,
    workspace_root: rule.workspace_root,
    command: rule.command,
    workdir: rule.workdir,
    tty: rule.tty,
    shell: rule.shell,
    package_script: rule.package_script,
    created_at: rule.created_at,
  };
}

function sameExecution(rule, { workspaceContext, environment, args }) {
  return rule.environment_id === String(environment.id) &&
    rule.workspace_id === String(workspaceContext.workspace_id) &&
    rule.workspace_root === String(workspaceContext.workspace_root) &&
    rule.command === normalizeCommand(args.cmd) &&
    rule.workdir === normalizeWorkdir(args.workdir) &&
    rule.shell === effectiveShell(args, environment) &&
    Boolean(rule.tty) === Boolean(args.tty);
}

export class TrustedPackageScriptStore {
  constructor({ stateFile = null, audit = null, now = () => new Date() } = {}) {
    this.stateFile = stateFile || null;
    this.audit = typeof audit === 'function' ? audit : null;
    this.now = now;
    this.rules = [];
    this.#load();
  }

  #emit(event, fields = {}) {
    if (!this.audit) return;
    this.audit({ component: 'trusted-package-script', event, ...fields });
  }

  #load() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''),
      );
      this.rules = Array.isArray(parsed?.rules)
        ? parsed.rules.filter((rule) => (
          rule?.rule_id &&
          rule?.environment_id &&
          rule?.workspace_id &&
          rule?.workspace_root &&
          rule?.command &&
          rule?.package_script?.package_manager &&
          rule?.package_script?.script &&
          rule?.package_script?.script_sha256
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
      { version: 1, rules: this.rules },
    );
  }

  mayMatch({ workspaceContext, environment, args }) {
    if (!parsePackageScriptCommand(args.cmd)) return false;
    return this.rules.some((rule) =>
      sameExecution(rule, { workspaceContext, environment, args }));
  }

  match({ workspaceContext, environment, args, packageScript }) {
    if (!packageScript) return null;
    for (const rule of this.rules) {
      if (!sameExecution(rule, { workspaceContext, environment, args })) continue;
      if (rule.package_script.package_manager !== packageScript.package_manager ||
          rule.package_script.script !== packageScript.script ||
          rule.package_script.script_sha256 !== packageScript.script_sha256) {
        this.#emit('rule_invalidated', {
          rule_id: rule.rule_id,
          environment_id: rule.environment_id,
          workspace_id: rule.workspace_id,
          reason: 'package_script_changed',
        });
        continue;
      }
      this.#emit('matched', {
        rule_id: rule.rule_id,
        environment_id: rule.environment_id,
        workspace_id: rule.workspace_id,
        package_manager: rule.package_script.package_manager,
        package_script: rule.package_script.script,
      });
      return publicRule(rule);
    }
    return null;
  }

  trust({ workspaceContext, environment, args, packageScript }) {
    if (!packageScript?.package_manager ||
        !packageScript?.script ||
        !packageScript?.script_sha256) {
      throw new Error('Trusted package-script rule requires a resolved script binding.');
    }
    if (!parsePackageScriptCommand(args.cmd)) {
      throw new Error('Only structurally simple package-script commands can be trusted.');
    }
    const candidate = {
      environment_id: String(environment.id),
      workspace_id: String(workspaceContext.workspace_id),
      workspace_root: String(workspaceContext.workspace_root),
      command: normalizeCommand(args.cmd),
      workdir: normalizeWorkdir(args.workdir),
      tty: Boolean(args.tty),
      shell: effectiveShell(args, environment),
      package_script: { ...packageScript },
    };
    const existing = this.rules.find((rule) =>
      sameExecution(rule, { workspaceContext, environment, args }) &&
      JSON.stringify(rule.package_script) === JSON.stringify(candidate.package_script));
    if (existing) return publicRule(existing);

    this.rules = this.rules.filter((rule) =>
      !sameExecution(rule, { workspaceContext, environment, args }));
    const rule = {
      rule_id: crypto.randomUUID(),
      ...candidate,
      created_at: this.now().toISOString(),
    };
    this.rules.push(rule);
    this.#persist();
    this.#emit('created', {
      rule_id: rule.rule_id,
      environment_id: rule.environment_id,
      workspace_id: rule.workspace_id,
      package_manager: rule.package_script.package_manager,
      package_script: rule.package_script.script,
    });
    return publicRule(rule);
  }

  revoke({ workspaceContext, environment, args }) {
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) =>
      !sameExecution(rule, { workspaceContext, environment, args }));
    if (this.rules.length !== before) this.#persist();
    return before - this.rules.length;
  }

  list() {
    return this.rules.map(publicRule);
  }

  close() {
    this.#persist();
  }
}
