import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexWindowsSandboxBackend, codexWorkspaceRootsOverride, resolveCodexRuntime } from '../src/runtime/sandbox/codex-windows-sandbox.mjs';

const ROOT = 'C:\\ccm work\\project';
const HOME = 'C:\\ccm-codex-sandbox\\private';
const EXE = 'C:\\Program Files\\Codex\\codex.exe';

function backend() {
  return new CodexWindowsSandboxBackend({
    resolveRuntime: () => EXE,
    codexHome: HOME,
    fileExists: (name) => name === path.win32.join(HOME, 'config.toml'),
  });
}
function invocation(overrides = {}) {
  return backend().buildInvocation({
    environment: { platform: 'windows', cwd: ROOT, workspaceRoots: [ROOT], shell: { path: 'pwsh.exe' } },
    cwd: path.win32.join(ROOT, 'src'),
    command: "Write-Output 'works'",
    permissionProfile: 'workspace-write',
    ...overrides,
  });
}

test('Codex adapter passes an entire native workspace-roots TOML override as one argv', () => {
  const result = invocation();
  assert.equal(result.file, EXE);
  assert.equal(result.sandboxed, true);
  assert.equal(result.environmentOverrides.CODEX_HOME, HOME);
  assert.deepEqual(result.args.slice(0, 7), [
    'sandbox', '-P', 'workspace-online', '-C', path.win32.join(ROOT, 'src'),
    '-c', codexWorkspaceRootsOverride(ROOT),
  ]);
  assert.deepEqual(result.args.slice(7), [
    '--', 'pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Write-Output 'works'",
  ]);
});

test('Codex adapter uses upstream read-only profile without any writable roots override', () => {
  const result = invocation({ permissionProfile: 'read-only' });
  assert.deepEqual(result.args.slice(0, 6), [
    'sandbox', '-P', 'read-only', '-C', path.win32.join(ROOT, 'src'), '--',
  ]);
  assert.equal(result.args.some((arg) => arg.includes('workspace_roots')), false);
});

test('approved Full Access bypasses Codex restricted runner just like upstream', () => {
  const result = invocation({ permissionProfile: 'full-access' });
  assert.equal(result.file, 'pwsh.exe');
  assert.equal(result.sandboxed, false);
  assert.equal(result.permissionProfile, 'full-access');
  assert.equal(result.args.at(-1), "Write-Output 'works'");
  assert.equal(result.environmentOverrides, undefined);
});

test('Codex adapter preserves upstream Shell Environment Policy login profile choice', () => {
  const withProfile = invocation({ useProfile: true });
  assert.equal(withProfile.args.includes('-NoProfile'), false);
  assert.equal(withProfile.args.includes('-NonInteractive'), true);
});

test('Codex adapter preserves commands with semicolons and shell metacharacters as one argument', () => {
  const command = "$env:TEST='a; b'; & 'C:\\Program Files\\x.exe' '<script>'";
  const result = invocation({ command });
  assert.equal(result.args.at(-1), command);
  assert.equal(result.args.filter((arg) => arg.includes(command)).length, 1);
  assert.equal(result.args.filter((arg) => arg.startsWith('permissions.')).length, 1);
});

test('Codex adapter rejects workdir escape, external home and unsupported CCM profiles', () => {
  assert.throws(() => invocation({ cwd: 'C:\\other' }), /outside the registered workspace/);
  assert.throws(() => invocation({ cwd: path.win32.join(ROOT, '..', 'other') }), /outside the registered workspace/);
  assert.throws(() => invocation({ permissionProfile: 'admin-workspace-write' }), /cannot accept/);
  assert.throws(() => invocation({ environment: { platform: 'linux', cwd: ROOT, workspaceRoots: [ROOT] } }), /Windows-only/);
  const unsafe = new CodexWindowsSandboxBackend({
    resolveRuntime: () => EXE, codexHome: path.win32.join(ROOT, '.codex'),
    fileExists: () => true,
  });
  assert.throws(() => unsafe.buildInvocation({
    environment: { platform: 'windows', cwd: ROOT, workspaceRoots: [ROOT] },
    cwd: ROOT, command: 'echo no', permissionProfile: 'workspace-write',
  }), /must be separate/);
});

test('Codex workspace root escaping remains TOML data, not command text', () => {
  const root = "C:\\a space\\let's \"quoted\" workspace";
  const override = codexWorkspaceRootsOverride(root);
  assert.match(override, /^permissions\.workspace-online\.workspace_roots=\{/);
  assert.match(override, / = true \}$/);
  assert.ok(override.includes(JSON.stringify(path.win32.normalize(root))));
  assert.throws(() => codexWorkspaceRootsOverride('..\\relative'), /absolute Windows path/);
});

test('Codex resolver accepts CLI updates and selects the newest complete runtime', () => {
  const root = 'C:\\Programs\\Codex\\bin';
  const dirs = ['old', 'current', 'incomplete'];
  const files = new Set([
    ...['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
      .map((name) => path.win32.join(root, 'current', name)),
    ...['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
      .map((name) => path.win32.join(root, 'old', name)),
    path.win32.join(root, 'incomplete', 'codex.exe'),
  ]);
  const options = {
    binRoot: root,
    readdir: () => dirs.map((name) => ({ name, isDirectory: () => true })),
    isFile: (file) => files.has(file),
    execute: (file) => ({
      status: 0, stdout: file.includes('\\current\\')
        ? 'codex-cli 0.166.0-alpha.6\n' : 'codex-cli 0.166.0-alpha.5.1\n',
    }),
  };
  assert.equal(resolveCodexRuntime(options), path.win32.join(root, 'current', 'codex.exe'));
  dirs.splice(0, 3, 'old');
  assert.equal(resolveCodexRuntime(options), path.win32.join(root, 'old', 'codex.exe'));
  dirs.splice(0, 1, 'current', 'another');
  files.add(path.win32.join(root, 'another', 'codex.exe'));
  files.add(path.win32.join(root, 'another', 'codex-command-runner.exe'));
  files.add(path.win32.join(root, 'another', 'codex-windows-sandbox-setup.exe'));
  const duplicate = {
    ...options,
    execute: () => ({ status: 0, stdout: 'codex-cli 0.166.0-alpha.6\n' }),
  };
  assert.throws(() => resolveCodexRuntime(duplicate), /Multiple equally recent/);
  assert.throws(() => resolveCodexRuntime({ ...options, isFile: () => false }),
    /requires an installed Codex CLI/);
});

test('Codex runtime selection follows SemVer for prereleases and stable releases', () => {
  const root = 'C:\\Codex\\bin';
  const dirs = ['alpha5', 'alpha6', 'stable', 'older'];
  const files = new Set(dirs.flatMap((directory) =>
    ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
      .map((name) => path.win32.join(root, directory, name))));
  const releases = {
    alpha5: 'codex-cli 0.166.0-alpha.5.1',
    alpha6: 'codex-cli 0.166.0-alpha.6',
    stable: 'codex-cli 0.166.0',
    older: 'codex-cli 0.165.99',
  };
  const options = {
    binRoot: root,
    readdir: () => dirs.map((name) => ({ name, isDirectory: () => true })),
    isFile: (file) => files.has(file),
    execute: (file) => ({
      status: 0,
      stdout: releases[path.win32.basename(path.win32.dirname(file))],
    }),
  };
  assert.equal(resolveCodexRuntime(options), path.win32.join(root, 'stable', 'codex.exe'));
  dirs.splice(dirs.indexOf('stable'), 1);
  assert.equal(resolveCodexRuntime(options), path.win32.join(root, 'alpha6', 'codex.exe'));
  dirs.splice(dirs.indexOf('alpha6'), 1);
  assert.equal(resolveCodexRuntime(options), path.win32.join(root, 'alpha5', 'codex.exe'));
  options.execute = () => ({ status: 0, stdout: 'unknown CLI output' });
  assert.throws(() => resolveCodexRuntime(options), /requires an installed Codex CLI/);
});

test('Codex resolver distinguishes sandbox-denied CLI execution from missing helpers', () => {
  const root = 'C:\\Codex\\bin';
  const complete = ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe'];
  const paths = new Set(complete.map((name) => path.win32.join(root, 'installed', name)));
  const options = {
    binRoot: root,
    readdir: () => [{ name: 'installed', isDirectory: () => true }],
    isFile: (candidate) => paths.has(candidate),
    execute: () => ({
      status: null,
      error: Object.assign(new Error('spawnSync codex.exe EPERM'), { code: 'EPERM' }),
    }),
  };
  assert.throws(() => resolveCodexRuntime(options),
    (error) => /installed.*cannot launch codex.exe \(EPERM\)/.test(error.message) &&
      /not a missing installation or a CLI version mismatch/.test(error.message));
  options.execute = () => {
    throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  };
  assert.throws(() => resolveCodexRuntime(options), /cannot launch codex.exe \(EACCES\)/);
  options.execute = () => ({ status: 0, stdout: 'codex-cli 0.167.0\n' });
  assert.equal(resolveCodexRuntime(options),
    path.win32.join(root, 'installed', 'codex.exe'));
  options.isFile = () => false;
  assert.throws(() => resolveCodexRuntime(options), /requires an installed Codex CLI/);
});

test('Codex resolver can use another complete installation if one is blocked', () => {
  const root = 'C:\\Codex\\bin';
  const names = ['blocked', 'available'];
  const paths = new Set(names.flatMap((directory) =>
    ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
      .map((name) => path.win32.join(root, directory, name))));
  const result = resolveCodexRuntime({
    binRoot: root,
    readdir: () => names.map((name) => ({ name, isDirectory: () => true })),
    isFile: (candidate) => paths.has(candidate),
    execute: (file) => file.includes('\\blocked\\')
      ? { error: Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
      : { status: 0, stdout: 'codex-cli 0.168.0\n' },
  });
  assert.equal(result, path.win32.join(root, 'available', 'codex.exe'));
});
