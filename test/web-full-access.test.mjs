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

test('web unlock waits for one claim, restores locked page state, and preserves previously claimed grants', () => {
  let now = 100_000;
  const grants = new WebFullAccess({ now: () => now });
  const first = grants.issue(60);
  assert.equal(grants.status().pending, true);
  assert.throws(() => grants.authorize(first.full_access_grant_id), /unknown or expired/);
  now += 30_000;
  const duplicate = grants.issue(604800);
  assert.equal(first.issued, true);
  assert.equal(duplicate.issued, false);
  assert.equal(duplicate.full_access_grant_id, first.full_access_grant_id);
  assert.equal(duplicate.expires_at, first.expires_at);
  assert.equal(grants.claim('00000000-0000-4000-8000-000000000000'), null);
  const claimed = grants.claim();
  assert.equal(claimed.duration_seconds, 60);
  assert.equal(claimed.full_access_grant_id, first.full_access_grant_id);
  assert.equal(claimed.expires_at, first.expires_at);
  assert.equal(grants.claim(), null);
  assert.deepEqual(grants.status(), { pending: false });
  assert.equal(grants.authorize(first.full_access_grant_id), true);
  const next = grants.issue(300);
  assert.equal(next.issued, true);
  assert.notEqual(next.full_access_grant_id, first.full_access_grant_id);
  assert.equal(grants.authorize(first.full_access_grant_id), true);
  now += 60_001;
  assert.throws(() => grants.authorize(first.full_access_grant_id), /expired/);
  assert.equal(grants.status().pending, true);
});

test('unclaimed pending grant expires in five minutes and can be replaced', () => {
  let now = 100_000;
  const grants = new WebFullAccess({ now: () => now });
  const first = grants.issue(3600);
  now += 299_000;
  assert.equal(grants.issue(3600).issued, false);
  assert.equal(grants.status().pending, true);
  now += 1001;
  assert.equal(grants.claim(), null);
  assert.deepEqual(grants.status(), { pending: false });
  assert.throws(() => grants.authorize(first.full_access_grant_id), /unknown or expired/);
  assert.equal(grants.issue(300).issued, true);
  assert.throws(() => grants.authorize('00000000-0000-4000-8000-000000000000'), /unknown/);
});

test('deferred fallback tool yields the already-active browser grant exactly once', async () => {
  const grants = new WebFullAccess();
  const issued = grants.issue(1800);
  const registry = registerCoreTools(new ToolRegistry(), { webFullAccess: grants });
  const claimed = await registry.get('claim_full_access').handler({});
  assert.equal(claimed.structuredContent.full_access_grant_id, issued.full_access_grant_id);
  assert.equal(claimed.structuredContent.expires_at, issued.expires_at);
  assert.deepEqual(grants.status(), { pending: false });
  assert.equal(grants.authorize(issued.full_access_grant_id), true);
  const duplicate = await registry.get('claim_full_access').handler({});
  assert.equal(duplicate.structuredContent.claimed, false);
});

test('web copy consumes the pending grant, then the model fallback can recover the same ID once', () => {
  let now = 100_000;
  const grants = new WebFullAccess({ now: () => now });
  const pending = grants.issue(3600);
  const claimed = grants.claim(pending.full_access_grant_id);
  assert.equal(claimed.full_access_grant_id, pending.full_access_grant_id);
  assert.deepEqual(grants.status(), { pending: false });
  assert.equal(grants.authorize(pending.full_access_grant_id), true);
  now += 240_000;
  const recovered = grants.claim();
  assert.equal(recovered.full_access_grant_id, pending.full_access_grant_id);
  assert.equal(recovered.expires_at, pending.expires_at);
  assert.equal(grants.claim(), null);
  assert.equal(grants.authorize(pending.full_access_grant_id), true);
  const second = grants.issue(300);
  assert.notEqual(second.full_access_grant_id, pending.full_access_grant_id);
  assert.equal(grants.authorize(pending.full_access_grant_id), true);
});

test('copy recovery expires at the original five-minute claim deadline', () => {
  let now = 100_000;
  const grants = new WebFullAccess({ now: () => now });
  const issued = grants.issue(3600);
  now += 60_000;
  grants.claim(issued.full_access_grant_id);
  now += 240_001;
  assert.equal(grants.claim(), null);
  assert.equal(grants.authorize(issued.full_access_grant_id), true);
});

test("one-minute pending grant expires without the five-minute window prolonging it", () => {
  let now = 10_000;
  const grants = new WebFullAccess({ now: () => now });
  const issued = grants.issue(60);
  now += 60_001;
  assert.deepEqual(grants.status(), { pending: false });
  assert.equal(grants.claim(), null);
  assert.throws(() => grants.authorize(issued.full_access_grant_id), /expired/);
});

test('phone enrollment revision change revokes pending and claimed grants', () => {
  let revision = 'first-phone';
  const grants = new WebFullAccess({ enrollmentRevision: () => revision });
  const issued = grants.issue(300);
  assert.throws(() => grants.authorize(issued.full_access_grant_id), /unknown or expired/);
  const first = grants.claim();
  assert.equal(grants.authorize(first.full_access_grant_id), true);
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

test('one browser-issued grant applies across new and existing Workers, without changing base profile', async () => {
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

test('web-issued Full Access grants controller-side patch dispatch while keeping Worker root identity', async () => {
  const grants = new WebFullAccess();
  grants.issue(60);
  const issued = grants.claim();
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
      bridge: async (action, value) =>
        action === 'status' ? grants.status() :
          action === 'claim' ? grants.claim(value) : grants.issue(value),
    });
    unlock.isConfigured = () => true;
    const config = createConfig({
      rootDir: root, readConfigFile: false,
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
    assert.throws(() => grants.authorize(issued.full_access_grant_id), /unknown or expired/);
    const unpairedPage = await fetch(origin + '/ccm/unlock');
    assert.doesNotMatch(await unpairedPage.text(), new RegExp(issued.full_access_grant_id));
    const activePage = await fetch(origin + '/ccm/unlock', { headers: { Cookie: combined } });
    const activeHtml = await activePage.text();
    assert.equal((activeHtml.match(/全权限待领取/g) || []).length, 1);
    assert.match(activeHtml, new RegExp(`id="grant-id">${issued.full_access_grant_id}</p>`));
    assert.match(activeHtml, /id="copy-grant" data-copy="CCM 全权限句柄 full_access_grant_id：/);
    assert.match(activeHtml, /不复制时，可直接让 ChatGPT 调用领取工具/);
    assert.doesNotMatch(activeHtml, /name="duration_seconds"|查看待认领授权/);
    const activeCsrf = activeHtml.match(/data-csrf="([^"]+)"/)[1];
    const activeCookie = activePage.headers.get('set-cookie').split(';', 1)[0] + '; ' + pairCookie;
    const claimRequest = (id, csrfValue = activeCsrf, cookieValue = activeCookie) => fetch(origin + '/ccm/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieValue },
      body: new URLSearchParams({ action: 'claim', csrf: csrfValue, grant_id: id }),
    });
    assert.equal((await claimRequest(issued.full_access_grant_id, 'invalid')).status, 403);
    assert.equal((await claimRequest(issued.full_access_grant_id, activeCsrf, activeCookie.split('; ')[0])).status, 403);
    assert.equal((await claimRequest('00000000-0000-4000-8000-000000000000')).status, 409);
    assert.equal(grants.status().pending, true);
    const script = activeHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const expectedHash = createHash('sha256').update(script).digest('base64');
    assert.ok(activePage.headers.get('content-security-policy').includes(`script-src 'sha256-${expectedHash}'`));
    assert.match(activePage.headers.get('content-security-policy'), /connect-src 'self'/);
    let click;
    let copied;
    let navigated;
    const button = {
      disabled: false,
      dataset: { copy: `CCM 全权限句柄 full_access_grant_id：${issued.full_access_grant_id}。网页完成复制领取并回到解锁页后，请在需要全权限的 CCM 工具调用中直接使用此参数。`, csrf: activeCsrf, grantId: issued.full_access_grant_id },
      textContent: '一键复制并领取全权限句柄',
      addEventListener: (type, handler) => { if (type === 'click') click = handler; },
    };
    let failedClick;
    const failedButton = { ...button, addEventListener: (_type, handler) => { failedClick = handler; } };
    runInNewContext(script, {
      document: { getElementById: () => failedButton },
      navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    });
    await failedClick();
    assert.equal(grants.status().pending, true);
    assert.equal(failedButton.disabled, false);
    assert.match(failedButton.textContent, /复制失败/);
    runInNewContext(script, {
      document: { getElementById: (id) => id === 'copy-grant' ? button : null },
      navigator: { clipboard: { writeText: async (value) => { copied = value; } } },
      URLSearchParams,
      fetch: async (_url, options) => fetch(origin + '/ccm/unlock', {
        ...options, headers: { ...options.headers, Cookie: activeCookie },
      }),
      window: { location: { replace: (value) => { navigated = value; } } },
    });
    assert.equal(typeof click, 'function');
    await click();
    assert.equal(copied, button.dataset.copy);
    assert.equal(copied.includes(issued.full_access_grant_id), true);
    assert.equal(navigated, '/ccm/unlock');
    assert.deepEqual(grants.status(), { pending: false });
    assert.equal(grants.authorize(issued.full_access_grant_id), true);
    assert.equal(grants.claim()?.full_access_grant_id, issued.full_access_grant_id);
    assert.equal(grants.claim(), null);
    assert.equal((await claimRequest(issued.full_access_grant_id)).status, 409);
    const claimedPage = await fetch(origin + '/ccm/unlock?issued=1', { headers: { Cookie: combined } });
    const claimedHtml = await claimedPage.text();
    assert.doesNotMatch(claimedHtml, new RegExp(issued.full_access_grant_id));
    assert.match(claimedHtml, /name="duration_seconds"/);
    const next = await request('unlock', { duration_seconds: '300' }, combined);
    assert.equal(next.status, 303);
    const nextGrant = grants.status();
    assert.notEqual(nextGrant.full_access_grant_id, issued.full_access_grant_id);
    assert.equal(grants.authorize(issued.full_access_grant_id), true);
    const fallback = grants.claim();
    assert.equal(fallback.full_access_grant_id, nextGrant.full_access_grant_id);
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
    const post = async (secret, action, value) => fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CCM-Unlock-Bridge': secret,
      },
      body: JSON.stringify({ action, duration_seconds: action === 'issue' ? value : undefined, grant_id: action === 'claim' ? value : undefined }),
    });
    assert.equal((await post('wrong', 'issue', 300)).status, 403);
    assert.equal((await post('test-secret-not-production', 'unknown')).status, 400);
    const first = await post('test-secret-not-production', 'issue', 300);
    assert.equal(first.status, 200);
    const issued = await first.json();
    assert.equal(issued.issued, true);
    const duplicate = await post('test-secret-not-production', 'issue', 604800);
    assert.equal((await duplicate.json()).issued, false);
    assert.equal((await post('wrong', 'claim', issued.full_access_grant_id)).status, 403);
    assert.equal((await post('test-secret-not-production', 'claim', undefined)).status, 400);
    assert.equal((await post('test-secret-not-production', 'claim', 'invalid')).status, 400);
    assert.equal((await post('test-secret-not-production', 'claim', '00000000-0000-4000-8000-000000000000')).status, 409);
    assert.equal(grants.status().pending, true);
    const claimed = await post('test-secret-not-production', 'claim', issued.full_access_grant_id);
    assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).full_access_grant_id, issued.full_access_grant_id);
    assert.equal(grants.status().pending, false);
    assert.equal(grants.authorize(issued.full_access_grant_id), true);
    assert.equal((await post('test-secret-not-production', 'claim', issued.full_access_grant_id)).status, 409);
  } finally {
    await controller.close();
  }
});
