import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrustedRemoteGitCommand,
  resolveGitAwarePermissionProfile,
} from '../src/runtime/sandbox/git-policy.mjs';
import { NativeSandboxBackend } from '../src/runtime/sandbox/native-sandbox.mjs';

test('trusted Git policy recognizes remote Git operations', () => {
  assert.equal(isTrustedRemoteGitCommand('git push origin main'), true);
  assert.equal(isTrustedRemoteGitCommand('git clone https://example.invalid/repo.git'), true);
  assert.equal(isTrustedRemoteGitCommand('git fetch --all --prune'), true);
  assert.equal(isTrustedRemoteGitCommand('git pull --ff-only'), true);
  assert.equal(isTrustedRemoteGitCommand('git ls-remote origin HEAD'), true);
  assert.equal(isTrustedRemoteGitCommand('git submodule update --init --recursive'), true);
  assert.equal(isTrustedRemoteGitCommand('git -c http.proxy=http://127.0.0.1:7890 push origin main'), true);
  assert.equal(isTrustedRemoteGitCommand('git --git-dir .git push origin main'), true);
});

test('trusted Git policy allows Git-only command sequences', () => {
  assert.equal(isTrustedRemoteGitCommand('git status --short; git push origin main'), true);
  assert.equal(isTrustedRemoteGitCommand('git fetch origin && git status --short'), true);
});

test('trusted Git policy rejects local-only and mixed shell commands', () => {
  assert.equal(isTrustedRemoteGitCommand('git status --short'), false);
  assert.equal(isTrustedRemoteGitCommand('git commit -m test'), false);
  assert.equal(isTrustedRemoteGitCommand('git push origin main; Write-Output done'), false);
  assert.equal(isTrustedRemoteGitCommand('git push origin main | Out-String'), false);
  assert.equal(isTrustedRemoteGitCommand('Write-Output git push origin main'), false);
});

test('workspace-write maps only trusted remote Git to trusted-git', () => {
  assert.equal(
    resolveGitAwarePermissionProfile('workspace-write', 'git push origin main'),
    'trusted-git',
  );
  assert.equal(
    resolveGitAwarePermissionProfile('workspace-write', 'git status --short'),
    'workspace-write',
  );
  assert.equal(
    resolveGitAwarePermissionProfile('read-only', 'git fetch origin'),
    'read-only',
  );
});

test('trusted-git uses the direct shell path instead of the Windows restricted token', () => {
  const backend = new NativeSandboxBackend({
    windowsHelperPath: 'C:\\definitely-missing\\ccm-sandbox-windows.exe',
  });
  const invocation = backend.buildInvocation({
    environment: {
      platform: 'windows',
      shell: { path: 'powershell.exe', type: 'powershell' },
      cwd: 'C:\\workspace',
      workspaceRoots: ['C:\\workspace'],
    },
    command: 'git push origin main',
    cwd: 'C:\\workspace',
    shell: { path: 'powershell.exe', type: 'powershell' },
    permissionProfile: 'trusted-git',
  });
  assert.equal(invocation.sandboxed, false);
  assert.equal(invocation.permissionProfile, 'trusted-git');
  assert.equal(invocation.file, 'powershell.exe');
});
