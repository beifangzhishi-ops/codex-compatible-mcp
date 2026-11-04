import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';
import {
  DEFAULT_TRUSTED_COMMANDS_FILE,
  evaluateTrustedCommand,
  loadTrustedCommands,
  trustedCommandDenialHint,
  validateTrustedCommands,
} from '../src/runtime/sandbox/trusted-commands.mjs';

const environment = {
  platform: 'windows',
  permissionProfile: 'workspace-write',
  shell: { path: 'powershell.exe' },
};
const pinnedPath = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const original = JSON.parse(fs.readFileSync(DEFAULT_TRUSTED_COMMANDS_FILE, 'utf8'));
const evaluate = (cmd, shell = 'powershell.exe', file = DEFAULT_TRUSTED_COMMANDS_FILE) =>
  evaluateTrustedCommand(cmd, shell, environment, { file });

test('tracked trusted-command configuration validates Git, Node, native build and Tailscale rules', () => {
  assert.deepEqual(validateTrustedCommands(original).map((rule) => rule.id),
    ['git-remote', 'node-test', 'npm-build-native', 'tailscale']);
  for (const command of [
    'git clone https://example.invalid/repo.git',
    'git fetch --all --prune',
    'git pull --ff-only',
    'git push origin main',
    'git ls-remote origin HEAD',
    'node --test test/approval.test.mjs',
    'npm run build:native',
  ]) {
    assert.equal(evaluate(command).matched, true, command);
  }
  for (const command of [
    'git status', 'git submodule update --init',
    'git -c core.sshCommand=whoami push origin main',
    'node -e process.exit(0)',
    'npm run random-script',
    'npm install',
    'npm run build',
  ]) {
    assert.equal(evaluate(command).matched, false, command);
  }
  assert.equal(evaluate('node --test', 'cmd.exe').matched, false);
  assert.deepEqual(evaluate('npm run build:native').rule_ids, ['npm-build-native']);
  assert.deepEqual(evaluate('npm run build:native', 'cmd.exe').rule_ids, ['npm-build-native']);
  assert.equal(evaluateTrustedCommand('git push', null,
    { ...environment, platform: 'linux' }), null);
});

test('PowerShell Tailscale aliases and fixed paths dispatch the same installed executable', () => {
  for (const cmd of [
    'tailscale status',
    'tailscale.exe status',
    `& '${pinnedPath}' status`,
    `& "${pinnedPath}" status`,
    `"${pinnedPath}" status`,
  ]) {
    assert.deepEqual(evaluate(cmd), {
      matched: true,
      rule_ids: ['tailscale'],
      cmd: `& '${pinnedPath}' status`,
    }, cmd);
  }
  assert.deepEqual(evaluate('tailscale status', 'pwsh.exe'), {
    matched: true,
    rule_ids: ['tailscale'],
    cmd: `& '${pinnedPath}' status`,
  });
});

test('CMD Tailscale single commands preserve the fixed executable via PowerShell', () => {
  for (const cmd of [
    'tailscale version', 'tailscale.exe version',
    `"${pinnedPath}" version`,
    `""${pinnedPath}" version"`,
  ]) {
    assert.deepEqual(evaluate(cmd, 'cmd.exe'), {
      matched: true,
      rule_ids: ['tailscale'],
      cmd: `& '${pinnedPath}' version`,
      shell: 'powershell.exe',
    }, cmd);
  }
});

test('all recognized sequential PowerShell segments must be trusted', () => {
  const cmd = 'tailscale status; git fetch origin; tailscale funnel status';
  assert.deepEqual(evaluate(cmd), {
    matched: true,
    rule_ids: ['tailscale', 'git-remote'],
    cmd: `& '${pinnedPath}' status; git fetch origin; & '${pinnedPath}' funnel status`,
  });
  const repeat = 'tailscale status; tailscale funnel status';
  assert.equal(evaluate(repeat).matched, true);
  assert.equal(evaluate('git fetch origin && git push origin main').matched, true);
  assert.equal(evaluate('git fetch origin || git pull').matched, true);
  assert.equal(evaluate('git fetch origin\ngit pull').matched, true);
  for (const command of [
    'tailscale status; Get-Date',
    'git push origin main; git clean -xfd',
    'git fetch | git push',
    'tailscale status | tailscale version',
    'tailscale status > output.txt',
    `& (Get-Command tailscale.exe) status`,
    `& "\\$env:ProgramFiles\\Tailscale\\tailscale.exe" status`,
    `& "${pinnedPath}"$(whoami)`,
    '.\\tailscale.exe version',
    'C:\\temp\\tailscale.exe version',
  ]) {
    assert.equal(evaluate(command).matched, false, command);
  }
});

test('CMD only auto-trusts compound unpinned programs; unsupported pinned combinations fail closed', () => {
  assert.equal(evaluate('git fetch origin && git push origin main', 'cmd.exe').matched, true);
  assert.equal(evaluate('tailscale status && tailscale version', 'cmd.exe').matched, false);
  assert.equal(evaluate('tailscale %PATH%', 'cmd.exe').matched, false);
  assert.equal(evaluate('tailscale ^& whoami', 'cmd.exe').matched, false);
});

test('trusted-command rules hot-reload from the chosen JSON file on every evaluation', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-trusted-commands-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'trusted-commands.json');
  fs.writeFileSync(file, JSON.stringify(original));
  assert.equal(evaluate('git status', undefined, file).matched, false);
  const changed = structuredClone(original);
  changed.rules[0].arguments.values.push('status');
  fs.writeFileSync(file, JSON.stringify(changed));
  assert.deepEqual(evaluate('git status', undefined, file).rule_ids, ['git-remote']);
  fs.writeFileSync(file, JSON.stringify(original));
  assert.equal(evaluate('git status', undefined, file).matched, false);
  fs.writeFileSync(file, '{invalid');
  assert.match(loadTrustedCommands(file).error, /configuration unavailable/i);
  assert.equal(evaluate('git push', undefined, file).matched, false);
  fs.rmSync(file);
  assert.equal(evaluate('git push', undefined, file).matched, false);
});

test('one Controller configuration snapshot is shared by both Worker routes and changes without restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-worker-trust-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'trusted-commands.json');
  fs.writeFileSync(file, JSON.stringify(original));

  const registry = new EnvironmentRegistry({ resolvePaths: false });
  for (const id of ['six', 'noha']) {
    registry.register({
      id,
      platform: 'windows',
      cwd: 'C:\\workspace',
      workspaceRoots: ['C:\\workspace'],
      permissionProfile: 'workspace-write',
      backend: 'remote-worker',
    });
  }
  const workerHub = new EventEmitter();
  const calls = [];
  workerHub.call = async (id, method, params) => {
    calls.push({ id, method, params });
    return { chunk_id: 'fake', wall_time_seconds: 0.01, exit_code: 0, output: '' };
  };
  const manager = new RemoteProcessManager({
    environmentRegistry: registry,
    workerHub,
    trustedCommandsFile: file,
    workspaceHandleManager: {
      resolve(handle) {
        const id = handle === 'six-handle' ? 'six' : 'noha';
        return {
          workspace_handle: handle,
          environment_id: id,
          workspace_id: 'ccm',
          workspace_root: 'C:\\workspace',
        };
      },
    },
  });
  t.after(() => manager.close());
  const run = async (handle, cmd) =>
    manager.execCommand({ workspace_handle: handle, cmd });
  const initial = await run('six-handle', 'git status');
  assert.equal(initial.trusted_command_rule_ids, undefined);
  assert.equal(calls.at(-1).params.sandbox_permissions, undefined);

  const added = structuredClone(original);
  added.rules[0].arguments.values.push('status');
  fs.writeFileSync(file, JSON.stringify(added));
  assert.deepEqual((await run('six-handle', 'git status')).trusted_command_rule_ids, ['git-remote']);
  assert.deepEqual((await run('noha-handle', 'git status')).trusted_command_rule_ids, ['git-remote']);
  assert.equal(calls.at(-1).id, 'noha');
  assert.equal(calls.at(-1).params.sandbox_permissions, 'approved_escalated');

  const compound = await run('noha-handle', 'tailscale status; git fetch origin');
  assert.deepEqual(compound.trusted_command_rule_ids, ['tailscale', 'git-remote']);
  assert.match(calls.at(-1).params.cmd, /^& 'C:\\Program Files\\Tailscale\\tailscale\.exe' status; git fetch origin$/);

  fs.writeFileSync(file, JSON.stringify(original));
  const removed = await run('noha-handle', 'git status');
  assert.equal(removed.trusted_command_rule_ids, undefined);
  assert.equal(calls.at(-1).params.sandbox_permissions, undefined);

  fs.writeFileSync(file, '{broken');
  const invalid = await run('six-handle', 'git push');
  assert.equal(invalid.trusted_command_rule_ids, undefined);
  assert.match(invalid.trusted_command_diagnostic, /configuration unavailable/i);
  assert.equal(calls.at(-1).params.sandbox_permissions, undefined);
});

test('malformed or overbroad schema fails closed without throwing during dispatch', () => {
  for (const broken of [
    { ...original, version: 2 },
    { ...original, extra: true },
    { ...original, rules: [original.rules[0], original.rules[0]] },
    { ...original, rules: [{ ...original.rules[0], executable: '*' }] },
    { ...original, rules: [{ ...original.rules[0], executables: ['C:\\wrong\\git.exe'] }] },
    { ...original, rules: [{ ...original.rules[0], execution: { type: 'pinned', path: 'git' } }] },
  ]) {
    assert.throws(() => validateTrustedCommands(broken));
  }
});

test('restricted Tailscale pipe failure reports the centralized rule file, not a one-command requirement', () => {
  const env = environment;
  const result = trustedCommandDenialHint({
    command: 'tailscale status; Write-Output probe',
    output: 'failed to connect to local tailscaled: Access is denied.',
    environment: env,
  });
  assert.match(result, /config\/trusted-commands\.json/);
  assert.doesNotMatch(result, /standalone|separate calls/);
  assert.equal(trustedCommandDenialHint({
    command: 'tailscale status', output: '# DNS health warning: Access is denied',
    environment: env,
  }), null);
  assert.equal(trustedCommandDenialHint({
    command: 'tailscale status',
    output: 'failed to connect to local tailscaled: Access is denied',
    environment: env, trusted: true,
  }), null);
});
