import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  CodexWindowsSandboxBackend,
  resolveNativeCodexRuntime,
} from '../src/runtime/sandbox/codex-windows-sandbox.mjs';

const ROOT = 'C:\\ccm work\\project';
const HOME = 'C:\\ccm-codex-sandbox\\private';
const EXE = 'C:\\ccm\\native\\bin\\ccm-codex-native-sandbox.exe';

function backend() {
  return new CodexWindowsSandboxBackend({
    resolveRuntime: () => EXE,
    codexHome: HOME,
    fileExists: (name) => name === path.win32.join(HOME, 'config.toml'),
  });
}

function invocation(overrides = {}) {
  return backend().buildInvocation({
    environment: { platform: 'windows', cwd: ROOT, workspaceRoots: [ROOT],
      shell: { path: 'pwsh.exe' } },
    cwd: path.win32.join(ROOT, 'src'),
    command: "Write-Output 'works'",
    permissionProfile: 'workspace-write',
    ...overrides,
  });
}

test('Codex backend invokes CCM-built Rust sandbox directly, not external Codex CLI', () => {
  const result = invocation();
  assert.equal(result.file, EXE);
  assert.equal(result.sandboxed, true);
  assert.equal(result.environmentOverrides.CODEX_HOME, HOME);
  assert.deepEqual(result.args, [
    '--workspace-root', ROOT,
    '--codex-home', HOME,
    '--cwd', path.win32.join(ROOT, 'src'),
    '--profile', 'workspace-online',
    '--', 'pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
    '-Command', "Write-Output 'works'",
  ]);
  assert.equal(result.args.includes('sandbox'), false);
  assert.equal(result.args.includes('codex.exe'), false);
});

test('read-only requests use Codex native read-only profile', () => {
  const result = invocation({ permissionProfile: 'read-only' });
  assert.deepEqual(result.args.slice(0, 10), [
    '--workspace-root', ROOT,
    '--codex-home', HOME,
    '--cwd', path.win32.join(ROOT, 'src'),
    '--profile', 'read-only',
    '--', 'pwsh.exe',
  ]);
});

test('Full Access bypasses native Codex sandbox as upstream does', () => {
  const result = invocation({ permissionProfile: 'full-access' });
  assert.equal(result.file, 'pwsh.exe');
  assert.equal(result.sandboxed, false);
  assert.equal(result.permissionProfile, 'full-access');
  assert.equal(result.environmentOverrides, undefined);
});

test('native sandbox preserves Codex shell profile choice and whole shell scripts', () => {
  const command = "$env:TEST='a; b'; & 'C:\\Program Files\\x.exe' '<script>'";
  const result = invocation({ command, useProfile: true });
  assert.equal(result.args.includes('-NoProfile'), false);
  assert.equal(result.args.includes('-NonInteractive'), true);
  assert.equal(result.args.at(-1), command);
  assert.equal(result.args.filter((arg) => arg.includes(command)).length, 1);
});

test('native sandbox rejects invalid environments, workspace escapes and unsafe profiles', () => {
  assert.throws(() => invocation({ cwd: 'C:\\other' }), /outside the registered workspace/);
  assert.throws(() => invocation({ cwd: path.win32.join(ROOT, '..', 'other') }),
    /outside the registered workspace/);
  assert.throws(() => invocation({ permissionProfile: 'admin-workspace-write' }),
    /unsupported CCM profile/);
  assert.throws(() => invocation({ environment: {
    platform: 'linux', cwd: ROOT, workspaceRoots: [ROOT] },
  }), /Windows-only/);
  const unsafe = new CodexWindowsSandboxBackend({
    resolveRuntime: () => EXE, codexHome: path.win32.join(ROOT, '.codex'),
    fileExists: () => true,
  });
  assert.throws(() => unsafe.buildInvocation({
    environment: { platform: 'windows', cwd: ROOT, workspaceRoots: [ROOT] },
    cwd: ROOT, command: 'echo no', permissionProfile: 'workspace-write',
  }), /must be separate/);
});

test('native runner resolver requires three colocated CCM-built executables', () => {
  const binDir = 'C:\\ccm\\native\\bin';
  const names = [
    'ccm-codex-native-sandbox.exe',
    'codex-command-runner.exe',
    'codex-windows-sandbox-setup.exe',
  ];
  const files = new Set(names.map((name) => path.win32.join(binDir, name)));
  assert.equal(resolveNativeCodexRuntime({
    binDir, fileExists: (candidate) => files.has(candidate),
  }), path.win32.join(binDir, names[0]));
  files.delete(path.win32.join(binDir, names[2]));
  assert.throws(() => resolveNativeCodexRuntime({
    binDir, fileExists: (candidate) => files.has(candidate),
  }), /codex-windows-sandbox-setup.exe.*build:codex-native/);
  assert.throws(() => resolveNativeCodexRuntime({
    binDir, fileExists: () => { throw new Error('EACCES'); },
  }), /not built/);
  assert.throws(() => resolveNativeCodexRuntime({
    binDir: 'relative', fileExists: () => true,
  }), /absolute Windows path/);
});
