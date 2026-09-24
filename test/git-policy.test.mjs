import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrustedRemoteGitCommand,
  resolveGitAwarePermissionProfile,
} from '../src/runtime/sandbox/git-policy.mjs';
import { NativeSandboxBackend } from '../src/runtime/sandbox/native-sandbox.mjs';

test('trusted Git policy recognizes narrowly scoped remote Git operations', () => {
  assert.equal(isTrustedRemoteGitCommand('git push origin main'), true);
  assert.equal(isTrustedRemoteGitCommand('git clone https://example.invalid/repo.git'), true);
  assert.equal(isTrustedRemoteGitCommand('git fetch --all --prune'), true);
  assert.equal(isTrustedRemoteGitCommand('git pull --ff-only'), true);
  assert.equal(isTrustedRemoteGitCommand('git ls-remote origin HEAD'), true);
});

test('trusted Git policy rejects execution-altering and broad Git forms', () => {
  assert.equal(isTrustedRemoteGitCommand('git submodule update --init --recursive'), false);
  assert.equal(isTrustedRemoteGitCommand('git remote add origin https://example.invalid/x'), false);
  assert.equal(isTrustedRemoteGitCommand('git lfs install'), false);
  assert.equal(isTrustedRemoteGitCommand('git -c core.sshCommand=whoami push origin main'), false);
  assert.equal(isTrustedRemoteGitCommand('git --exec-path C:\\tmp push origin main'), false);
  assert.equal(isTrustedRemoteGitCommand('git --git-dir .git push origin main'), false);
});

test('trusted Git policy requires every shell segment to be trusted remote Git', () => {
  assert.equal(isTrustedRemoteGitCommand('git push origin main && git fetch origin'), true);
  assert.equal(isTrustedRemoteGitCommand('git push origin main && git clean -xfd'), false);
  assert.equal(isTrustedRemoteGitCommand('git fetch origin && git reset --hard HEAD'), false);
  assert.equal(isTrustedRemoteGitCommand('git push origin main; Write-Output done'), false);
  assert.equal(isTrustedRemoteGitCommand('git push origin main | Out-String'), false);
});

test('trusted Git stays fail-closed off Windows', () => {
  assert.equal(
    resolveGitAwarePermissionProfile(
      'workspace-write',
      'git push origin main',
      { platform: 'linux', shell: 'bash' },
    ),
    'workspace-write',
  );
});

test('workspace-write maps trusted Windows remote Git to trusted-git', () => {
  assert.equal(
    resolveGitAwarePermissionProfile(
      'workspace-write',
      'git push origin main',
      { platform: 'windows', shell: 'powershell.exe' },
    ),
    'trusted-git',
  );
  assert.equal(
    resolveGitAwarePermissionProfile(
      'workspace-write',
      'git status --short',
      { platform: 'windows', shell: 'powershell.exe' },
    ),
    'workspace-write',
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
