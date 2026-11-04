import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { WebFullAccess } from '../src/controller/web-full-access.mjs';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';
import { RemoteFileService } from '../src/runtime/filesystem/remote-file-service.mjs';
import { NativeFileService } from '../src/runtime/filesystem/native-file-service.mjs';
import { CcmWebUnlock } from '../ccm-sidecar/web-unlock.mjs';
import { createConfig } from '../ccm-sidecar/config.mjs';
import { createCcmOAuthServer, listenCcmOAuthServer, closeCcmOAuthServer } from '../ccm-sidecar/server.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';

test('pending unlock duplicate keeps original expiry and single claim', () => {
  let now = 100_000;
  const grants = new WebFullAccess({ now: () => now });
  const first = grants.issue(60);
  now += 30_000;
  const duplicate = grants.issue(604800);
  assert.equal(first.issued, true);
  assert.equal(duplicate.issued, false);
  assert.equal(duplicate.claim_expires_at, first.claim_expires_at);
  const claimed = grants.claim();
  assert.equal(claimed.duration_seconds, 60);
  assert.equal(grants.claim(), null);
  assert.equal(grants.authorize(claimed.full_access_grant_id), true);
  now += 60_001;
  assert.throws(() => grants.authorize(claimed.full_access_grant_id), /expired/);
  assert.equal(grants.issue(300).issued, true);
});

test('unclaimed unlock expires without extending and incorrect grants fail closed', () => {
  let now = 100_000;
  const grants = new WebFullAccess({ now: () => now });
  grants.issue(300);
  now += 299_000;
  assert.equal(grants.issue(300).issued, false);
  now += 1001;
  assert.equal(grants.claim(), null);
  assert.equal(grants.issue(300).issued, true);
  assert.throws(() => grants.authorize('00000000-0000-4000-8000-000000000000'), /unknown/);
});

test('phone enrollment revision change revokes pending and claimed global grants', () => {
  let revision = 'first-phone';
  const grants = new WebFullAccess({ enrollmentRevision: () => revision });
  grants.issue(300);
  const first = grants.claim();
  assert.equal(grants.authorize(first.full_access_grant_id), true);
  grants.issue(300);
  revision = null;
  assert.deepEqual(grants.status(), { pending: false });
  assert.throws(() => grants.authorize(first.full_access_grant_id), /not confirmed/);
  assert.throws(() => grants.issue(300), /not confirmed/);
  revision = 'replacement-phone';
  assert.equal(grants.claim(), null);
  assert.throws(() => grants.authorize(first.full_access_grant_id), /unknown or expired/);
});

test('local PowerShell TOTP implementation passes RFC and confirmation-window self-tests', {
  skip: process.platform !== 'win32',
}, () => {
  const script = path.resolve('scripts', 'manage-ccm-totp.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Action', 'SelfTest',
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /TOTP PowerShell self-test: PASS/);
});

test('one claimed grant applies across new and existing Workers, without changing base profile', async () => {
  const grants = new WebFullAccess();
  grants.issue(300);
  const { full_access_grant_id: grant } = grants.claim();
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
    resolve(handle) {
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

test('claimed Full Access grants controller-side patch dispatch while keeping Worker root identity', async () => {
  const grants = new WebFullAccess();
  grants.issue(60);
  const claimed = grants.claim();
  let forwarded;
  const files = new RemoteFileService({
    webFullAccess: grants,
    environmentRegistry: { resolve: () => ({ id: 'new-worker', capabilities: { applyPatch: true } }) },
    workspaceHandleManager: { resolve: () => ({
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
  await files.applyPatch({ workspace_handle: 'valid-handle', patch, full_access_grant_id: claimed.full_access_grant_id });
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
    }), /workspace-write forbids/);
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

test('real sidecar HTTP pairing, CSRF, duplicate unlock, and page status', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ccm-web-unlock-test-'));
  let runtime;
  try {
    const grants = new WebFullAccess();
    const unlock = new CcmWebUnlock({
      stateFile: path.join(root, 'browsers.json'),
      secret: 'fake-test-only-secret',
      totp: { verify: (code) => code === '123456' },
      bridge: async (action, seconds) =>
        action === 'status' ? grants.status() : grants.issue(seconds),
    });
    unlock.isConfigured = () => true;
    const config = createConfig({
      rootDir: root, readEnvFile: false,
      issuer: 'https://example.test/ccm',
      resource: 'https://example.test/ccm/mcp',
      allowEphemeral: true, port: 0,
      stateFile: path.join(root, 'oauth.json'),
      approvalSecret: 'fake-test-only-secret-long',
    });
    runtime = createCcmOAuthServer({ config, webUnlock: unlock, logger: { error() {} } });
    await listenCcmOAuthServer(runtime, 0);
    const origin = 'http://127.0.0.1:' + runtime.server.address().port;
    const get = await fetch(origin + '/ccm/unlock');
    assert.equal(get.status, 200);
    const page = await get.text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)[1];
    const csrfCookie = get.headers.get('set-cookie').split(';', 1)[0];
    const request = (action, form, cookie) => fetch(origin + '/ccm/unlock', {
      method: 'POST', redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: new URLSearchParams({ action, csrf, ...form }),
    });
    assert.equal((await request('pair', { code: '123456' })).status, 403);
    assert.equal((await request('pair', { code: 'bad' }, csrfCookie)).status, 403);
    const paired = await request('pair', { code: '123456' }, csrfCookie);
    assert.equal(paired.status, 303);
    const pairCookie = paired.headers.get('set-cookie').split(';', 1)[0];
    const combined = csrfCookie + '; ' + pairCookie;
    const first = await request('unlock', { duration_seconds: '60' }, combined);
    const deadline = grants.status().claim_expires_at;
    const second = await request('unlock', { duration_seconds: '3600' }, combined);
    assert.equal(first.headers.get('location'), '/ccm/unlock?issued=1');
    assert.equal(second.headers.get('location'), '/ccm/unlock?pending=1');
    assert.equal(grants.status().claim_expires_at, deadline);
    const pendingPage = await fetch(origin + '/ccm/unlock', { headers: { Cookie: combined } });
    assert.match(await pendingPage.text(), /已有待认领授权/);
  } finally {
    if (runtime) await closeCcmOAuthServer(runtime);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Controller loopback unlock bridge requires its shared secret and rejects invalid actions', async () => {
  const grants = new WebFullAccess();
  const controller = createHttpController({
    toolRegistry: { listDirect: () => [] },
    runtime: {
      webFullAccess: grants,
      environmentRegistry: { defaultEnvironmentId: '6v', listPublic: () => [] },
      workerHub: {},
      close: async () => {},
    },
    port: 0, host: '127.0.0.1',
    unlockBridgeSecret: 'test-secret-not-production',
  });
  await controller.start();
  try {
    const address = controller.address;
    const url = 'http://127.0.0.1:' + address.port + '/ccm/internal/web-unlock';
    const post = async (secret, action, seconds) => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CCM-Unlock-Bridge': secret,
      },
      body: JSON.stringify({ action, duration_seconds: seconds }),
    });
    assert.equal((await post('wrong', 'issue', 300)).status, 403);
    assert.equal((await post('test-secret-not-production', 'unknown')).status, 400);
    const first = await post('test-secret-not-production', 'issue', 300);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).issued, true);
    const duplicate = await post('test-secret-not-production', 'issue', 604800);
    assert.equal((await duplicate.json()).issued, false);
  } finally {
    await controller.close();
  }
});
