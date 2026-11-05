import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexWindowsSandboxBackend, codexWorkspaceRootsOverride, resolvePinnedCodexRuntime } from '../src/runtime/sandbox/codex-windows-sandbox.mjs';

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
  assert.throws(() => invocation({ permissionProfile: 'full-access' }), /cannot accept/);
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

test('Pinned Codex resolver requires one version and all matching native helper binaries', () => {
  const root = 'C:\\Programs\\Codex\\bin';
  const dirs = ['old', 'current'];
  const files = new Set([
    ...['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
      .map((name) => path.win32.join(root, 'current', name)),
    ...['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']
      .map((name) => path.win32.join(root, 'old', name)),
  ]);
  const options = {
    binRoot: root,
    readdir: () => dirs.map((name) => ({ name, isDirectory: () => true })),
    isFile: (file) => files.has(file),
    execute: (file) => ({
      status: 0, stdout: file.includes('\\current\\') ? 'codex-cli 0.166.0-alpha.5.1\n' : 'codex-cli 0.166.0-alpha.6\n',
    }),
  };
  assert.equal(resolvePinnedCodexRuntime(options), path.win32.join(root, 'current', 'codex.exe'));
  dirs.splice(0, 2, 'old');
  assert.throws(() => resolvePinnedCodexRuntime(options), /found 0/);
  dirs.splice(0, 1, 'current', 'another');
  files.add(path.win32.join(root, 'another', 'codex.exe'));
  files.add(path.win32.join(root, 'another', 'codex-command-runner.exe'));
  files.add(path.win32.join(root, 'another', 'codex-windows-sandbox-setup.exe'));
  const duplicate = {
    ...options,
    execute: () => ({ status: 0, stdout: 'codex-cli 0.166.0-alpha.5.1\n' }),
  };
  assert.throws(() => resolvePinnedCodexRuntime(duplicate), /found 2/);
});
