import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { WebFullAccess } from '../src/controller/web-full-access.mjs';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';
import { RemoteFileService } from '../src/runtime/filesystem/remote-file-service.mjs';
import { NativeFileService } from '../src/runtime/filesystem/native-file-service.mjs';
import { CcmWebUnlock } from '../ccm-sidecar/web-unlock.mjs';
import { createConfig } from '../ccm-sidecar/config.mjs';
import { createCcmOAuthServer, listenCcmOAuthServer, closeCcmOAuthServer } from '../ccm-sidecar/server.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';

test('web unlock immediately activates a grant; fallback claim returns the same ID without extending expiry', () => {
  let now = 100_000;
  const grants = new WebFullAccess({ now: () => now });
  const first = grants.issue(60);
  assert.equal(grants.authorize(first.full_access_grant_id), true);
  now += 30_000;
  const duplicate = grants.issue(604800);
  assert.equal(first.issued, true);
  assert.equal(duplicate.issued, false);
  assert.equal(duplicate.full_access_grant_id, first.full_access_grant_id);
  assert.equal(duplicate.expires_at, first.expires_at);
  const claimed = grants.claim();
  assert.equal(claimed.duration_seconds, 60);
  assert.equal(claimed.full_access_grant_id, first.full_access_grant_id);
  assert.equal(claimed.expires_at, first.expires_at);
  assert.equal(grants.claim(), null);
  assert.equal(grants.status().claim_available, false);
  assert.equal(grants.authorize(first.full_access_grant_id), true);
  now += 60_001;
  assert.throws(() => grants.authorize(first.full_access_grant_id), /expired/);
  assert.equal(grants.status().active, false);
  assert.equal(grants.issue(300).issued, true);
});

test('unclaimed fallback expires in five minutes while longer web grant remains active', () => {
  let now = 100_000;
  const grants = new WebFullAccess({ now: () => now });
  const first = grants.issue(3600);
  now += 299_000;
  assert.equal(grants.issue(3600).issued, false);
  assert.equal(grants.status().claim_available, true);
  now += 1001;
  assert.equal(grants.claim(), null);
  assert.equal(grants.status().claim_available, false);
  assert.equal(grants.status().full_access_grant_id, first.full_access_grant_id);
  assert.equal(grants.authorize(first.full_access_grant_id), true);
  assert.equal(grants.issue(300).issued, false);
  assert.throws(() => grants.authorize('00000000-0000-4000-8000-000000000000'), /unknown/);
});

test('deferred fallback tool yields the already-active browser grant exactly once', async () => {
  const grants = new WebFullAccess();
  const issued = grants.issue(1800);
  const registry = registerCoreTools(new ToolRegistry(), { webFullAccess: grants });
  const claimed = await registry.get('claim_full_access').handler({});
  assert.equal(claimed.structuredContent.full_access_grant_id, issued.full_access_grant_id);
  assert.equal(claimed.structuredContent.expires_at, issued.expires_at);
  assert.equal(grants.authorize(issued.full_access_grant_id), true);
  const duplicate = await registry.get('claim_full_access').handler({});
  assert.equal(duplicate.structuredContent.claimed, false);
});

test("one-minute grant expires without the fallback's five-minute window prolonging it", () => {
  let now = 10_000;
  const grants = new WebFullAccess({ now: () => now });
  const issued = grants.issue(60);
  now += 60_001;
  assert.deepEqual(grants.status(), { active: false });
  assert.equal(grants.claim(), null);
  assert.throws(() => grants.authorize(issued.full_access_grant_id), /expired/);
});

test('phone enrollment revision change revokes directly issued and fallback-claimed grants', () => {
  let revision = 'first-phone';
  const grants = new WebFullAccess({ enrollmentRevision: () => revision });
  const issued = grants.issue(300);
  assert.equal(grants.authorize(issued.full_access_grant_id), true);
  const first = grants.claim();
  assert.equal(grants.authorize(first.full_access_grant_id), true);
  revision = null;
  assert.deepEqual(grants.status(), { active: false });
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

test('web-issued Full Access grants controller-side patch dispatch while keeping Worker root identity', async () => {
  const grants = new WebFullAccess();
  const issued = grants.issue(60);
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
    assert.doesNotMatch(page, /id="copy-grant"|全权限已解锁/);
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
    const issued = grants.status();
    const deadline = issued.expires_at;
    const second = await request('unlock', { duration_seconds: '3600' }, combined);
    assert.equal(first.headers.get('location'), '/ccm/unlock');
    assert.equal(second.headers.get('location'), '/ccm/unlock');
    assert.equal(grants.status().expires_at, deadline);
    assert.equal(grants.status().full_access_grant_id, issued.full_access_grant_id);
    const unpairedPage = await fetch(origin + '/ccm/unlock');
    assert.doesNotMatch(await unpairedPage.text(), new RegExp(issued.full_access_grant_id));
    const activePage = await fetch(origin + '/ccm/unlock', { headers: { Cookie: combined } });
    const activeHtml = await activePage.text();
    assert.equal((activeHtml.match(/全权限已解锁/g) || []).length, 1);
    assert.match(activeHtml, new RegExp(`id="grant-id">${issued.full_access_grant_id}</p>`));
    assert.match(activeHtml, /id="copy-grant" data-copy="CCM 全权限句柄 full_access_grant_id：/);
    assert.match(activeHtml, /CCM 已解锁，请调用领取工具/);
    assert.doesNotMatch(activeHtml, /name="duration_seconds"|查看待认领授权/);
    const script = activeHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const expectedHash = createHash('sha256').update(script).digest('base64');
    assert.ok(activePage.headers.get('content-security-policy').includes(`script-src 'sha256-${expectedHash}'`));
    let click;
    let copied;
    const button = {
      dataset: { copy: `CCM 全权限句柄 full_access_grant_id：${issued.full_access_grant_id}。请在需要全权限的 CCM 工具调用中直接使用此参数，无需领取。` },
      textContent: '一键复制全权限句柄',
      addEventListener: (type, handler) => { if (type === 'click') click = handler; },
    };
    runInNewContext(script, {
      document: { getElementById: (id) => id === 'copy-grant' ? button : null },
      navigator: { clipboard: { writeText: async (value) => { copied = value; } } },
    });
    assert.equal(typeof click, 'function');
    await click();
    assert.equal(copied, button.dataset.copy);
    assert.equal(copied.includes(issued.full_access_grant_id), true);
    assert.match(button.textContent, /已复制/);

    const fallback = grants.claim();
    assert.equal(fallback.full_access_grant_id, issued.full_access_grant_id);
    assert.equal(fallback.expires_at, deadline);
    const claimedPage = await fetch(origin + '/ccm/unlock?issued=1', { headers: { Cookie: combined } });
    const claimedHtml = await claimedPage.text();
    assert.match(claimedHtml, new RegExp(`id="grant-id">${issued.full_access_grant_id}</p>`));
    assert.doesNotMatch(claimedHtml, /CCM 已解锁，请调用领取工具|name="duration_seconds"/);
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
