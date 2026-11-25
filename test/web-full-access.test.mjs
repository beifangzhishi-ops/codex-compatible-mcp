import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WebFullAccess } from '../src/controller/web-full-access.mjs';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';
import { RemoteFileService } from '../src/runtime/filesystem/remote-file-service.mjs';
import { NativeFileService } from '../src/runtime/filesystem/native-file-service.mjs';

test('owner-issued grants are immediately active, independent, revocable and expire without renewal', () => {
  let now = 1000;
  const grants = new WebFullAccess({ now: () => now });
  assert.equal(grants.authorize(undefined), false);
  assert.throws(() => grants.issue(42), /Invalid authorization duration/);
  const first = grants.issue(60);
  const second = grants.issue(300);
  assert.notEqual(first.full_access_grant_id, second.full_access_grant_id);
  assert.equal(grants.authorize(first.full_access_grant_id), true);
  assert.deepEqual(grants.list(), [first, second]);
  now += 60000;
  assert.throws(() => grants.authorize(first.full_access_grant_id), /unknown or expired/);
  assert.deepEqual(grants.list(), [second]);
  assert.equal(grants.revoke(second.full_access_grant_id), true);
  assert.throws(() => grants.authorize(second.full_access_grant_id), /unknown or expired/);
  assert.deepEqual(grants.list(), []);
  assert.equal(grants.revoke(second.full_access_grant_id), false);
  const third = grants.issue(300);
  assert.throws(() => new WebFullAccess().authorize(third.full_access_grant_id), /unknown or expired/);
});

test('one browser-issued grant applies across new and existing Workers, without changing base profile', async () => {
  const grants = new WebFullAccess();
  const { full_access_grant_id: grant } = grants.issue(300);
  const sent = [];
  const registry = {
    resolve(id) {
      return {
        id, platform: 'windows', permissionProfile: 'workspace-write',
        shell: { type: 'powershell', path: 'powershell.exe' },
      };
    },
  };
  const handleManager = {
    resolveOrCreate(handle) {
      return {
        workspace_handle: handle,
        environment_id: handle === '6v' ? '6v' : 'newly-added-worker',
        workspace_id: 'test', workspace_root: 'C:\\repo', workspace_kind: 'registered',
      };
    },
  };
  const hub = {
    on() {},
    off() {},
    async call(environment, method, args) {
      sent.push({ environment, method, args });
      return { wall_time_seconds: 0, exit_code: 0, output: 'ok' };
    },
  };
  const manager = new RemoteProcessManager({
    environmentRegistry: registry, workerHub: hub,
    workspaceHandleManager: handleManager, webFullAccess: grants,
  });
  for (const handle of ['6v', 'new']) {
    await manager.execCommand({
      cmd: 'Write-Output ok', workspace_handle: handle, full_access_grant_id: grant,
    });
  }
  assert.deepEqual(sent.map((c) => c.environment), ['6v', 'newly-added-worker']);
  assert.ok(sent.every((c) => c.args.sandbox_permissions === 'approved_escalated'));
  assert.ok(sent.every((c) => c.args.full_access_grant_id === undefined));
  await manager.execCommand({ cmd: 'Write-Output ok', workspace_handle: '6v' });
  assert.notEqual(sent[2].args.sandbox_permissions, 'approved_escalated');
  assert.equal(registry.resolve('6v').permissionProfile, 'workspace-write');
  await manager.close();
});

test('web-issued Full Access grants controller-side patch dispatch while keeping Worker root identity', async () => {
  const grants = new WebFullAccess();
  const issued = grants.issue(60);
  let forwarded;
  const files = new RemoteFileService({
    webFullAccess: grants,
    environmentRegistry: { resolve: () => ({ id: 'new-worker', capabilities: { applyPatch: true } }) },
    workspaceHandleManager: { resolveOrCreate: () => ({
      environment_id: 'new-worker', workspace_id: 'project',
      workspace_root: 'C:\\project', workspace_handle: 'valid-handle',
    }) },
    workerHub: { call: async (_id, method, args) => {
      assert.equal(method, 'apply_patch');
      forwarded = args;
      return { output: 'Done!' };
    } },
  });
  const patch = '*** Begin Patch\n*** Add File: example.txt\n+test\n*** End Patch';
  await assert.rejects(
    files.applyPatch({ workspace_handle: 'valid-handle', patch, full_access_grant_id: 'bad' }),
    /unknown or expired/,
  );
  await files.applyPatch({ workspace_handle: 'valid-handle', patch, full_access_grant_id: issued.full_access_grant_id });
  assert.equal(forwarded.sandbox_permissions, 'approved_escalated');
  assert.equal(forwarded.expected_workspace_root, 'C:\\project');
  assert.equal(forwarded.full_access_grant_id, undefined);
});

test('Worker patching uses full-access only for explicitly approved internal dispatch', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'ccm-grant-patch-'));
  try {
    const root = path.join(temp, 'registered');
    mkdirSync(root);
    const outside = path.join(temp, 'outside.txt');
    const environment = {
      id: '6v', platform: process.platform, permissionProfile: 'workspace-write',
      cwd: root, workspaceRoots: [root],
    };
    const workerFiles = new NativeFileService({
      environmentRegistry: { resolve: () => environment },
    });
    const patch = '*** Begin Patch\n*** Add File: ' + outside + '\n+outside\n*** End Patch';
    await assert.rejects(workerFiles.applyPatch({
      environment_id: '6v', patch,
    }), /Failed to write file/);
    assert.equal(existsSync(outside), false);
    await workerFiles.applyPatch({
      environment_id: '6v', patch, sandbox_permissions: 'approved_escalated',
    });
    assert.equal(existsSync(outside), true);
    assert.equal(environment.permissionProfile, 'workspace-write');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
