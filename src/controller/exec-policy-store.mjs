import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function normalizeCommand(value) {
  return String(value || '').trim();
}

function normalizeNullable(value) {
  return value == null || value === '' ? null : String(value);
}

export function parsePackageScriptCommand(command) {
  const match = normalizeCommand(command).match(
    /^(npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?)\s+(?:(run)\s+)?([A-Za-z0-9:_-]+)$/i,
  );
  if (!match) return null;
  const executable = match[1].toLowerCase().replace(/\.cmd$/, '');
  const script = match[3];
  return { package_manager: executable, script };
}

export function hashPackageScript(scriptText) {
  return crypto
    .createHash('sha256')
    .update(String(scriptText))
    .digest('hex');
}

function publicRule(rule) {
  return {
    rule_id: rule.rule_id,
    decision: rule.decision,
    environment_id: rule.environment_id,
    workspace_id: rule.workspace_id,
    workspace_root: rule.workspace_root,
    command: rule.command,
    workdir: rule.workdir,
    tty: rule.tty,
    shell: rule.shell,
    package_script: rule.package_script || null,
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
    if (!this.audit) return;
    this.audit({ component: 'exec-policy', event, ...fields });
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
          rule?.decision &&
          rule?.environment_id &&
          rule?.workspace_id &&
          rule?.workspace_root &&
          rule?.command
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
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(
      this.stateFile,
      JSON.stringify({ version: 1, rules: this.rules }, null, 2) + '\n',
      'utf8',
    );
  }

  match({ workspaceContext, environment, args, packageScript = null }) {
    const command = normalizeCommand(args.cmd);
    const workdir = normalizeNullable(args.workdir);
    const shell = normalizeNullable(args.shell);
    const tty = Boolean(args.tty);
    for (const rule of this.rules) {
      if (rule.environment_id !== String(environment.id) ||
          rule.workspace_id !== String(workspaceContext.workspace_id) ||
          rule.workspace_root !== String(workspaceContext.workspace_root) ||
          rule.command !== command ||
          rule.workdir !== workdir ||
          rule.shell !== shell ||
          Boolean(rule.tty) !== tty) {
        continue;
      }
      if (rule.package_script) {
        if (!packageScript ||
            rule.package_script.package_manager !== packageScript.package_manager ||
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
      }
      this.#emit('matched', {
        rule_id: rule.rule_id,
        decision: rule.decision,
        environment_id: rule.environment_id,
        workspace_id: rule.workspace_id,
      });
      return publicRule(rule);
    }
    return null;
  }

  allow({ workspaceContext, environment, args, packageScript = null }) {
    const candidate = {
      decision: 'allow',
      environment_id: String(environment.id),
      workspace_id: String(workspaceContext.workspace_id),
      workspace_root: String(workspaceContext.workspace_root),
      command: normalizeCommand(args.cmd),
      workdir: normalizeNullable(args.workdir),
      tty: Boolean(args.tty),
      shell: normalizeNullable(args.shell),
      package_script: packageScript || null,
    };
    const existing = this.rules.find((rule) => (
      rule.decision === candidate.decision &&
      rule.environment_id === candidate.environment_id &&
      rule.workspace_id === candidate.workspace_id &&
      rule.workspace_root === candidate.workspace_root &&
      rule.command === candidate.command &&
      rule.workdir === candidate.workdir &&
      Boolean(rule.tty) === candidate.tty &&
      rule.shell === candidate.shell &&
      JSON.stringify(rule.package_script || null) ===
        JSON.stringify(candidate.package_script || null)
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
      package_manager: rule.package_script?.package_manager,
      package_script: rule.package_script?.script,
    });
    return publicRule(rule);
  }

  close() {
    this.#persist();
  }
}
