import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { NativeSandboxBackend } from '../src/runtime/sandbox/native-sandbox.mjs';

const backend = new NativeSandboxBackend({
  windowsHelperPath: fileURLToPath(import.meta.url),
});
const environment = {
  platform: 'windows',
  cwd: 'C:\\work',
  workspaceRoots: ['C:\\work'],
  shell: { path: 'powershell.exe' },
};

test('Codex experimental_use_profile controls full-access PowerShell profile', () => {
  const make = (useProfile) => backend.buildInvocation({
    environment,
    command: 'Write-Output ok',
    cwd: 'C:\\work',
    permissionProfile: 'full-access',
    useProfile,
  });
  assert.ok(make(false).args.includes('-NoProfile'));
  assert.equal(make(true).args.includes('-NoProfile'), false);
});

test('Codex experimental_use_profile is sent to restricted native helper', () => {
  const make = (useProfile) => backend.buildInvocation({
    environment,
    command: 'Write-Output ok',
    cwd: 'C:\\work',
    permissionProfile: 'workspace-write',
    useProfile,
  });
  assert.equal(make(false).args.at(-1), 'false');
  assert.equal(make(true).args.at(-1), 'true');
  assert.equal(make(true).args.at(-2), '--use-profile');
});
