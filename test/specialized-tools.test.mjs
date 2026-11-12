import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerSpecializedTools } from '../src/tools/specialized-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';
import { PUBLISHED_FILE_UI_URI } from '../src/ui/published-file-app.mjs';
import { PlanManager } from '../src/controller/plan-manager.mjs';

function fakeRuntime() {
  const calls = [];
  const contexts = new Map();
  return {
    calls,
    environmentRegistry: {
      resolve(environmentId) {
        return {
          id: environmentId || 'windows-worker',
          platform: 'windows',
        };
      },
    },
    workspaceHandleManager: {
      async createProjectless(environmentId = null) {
        const context = {
          workspace_handle: '00000000-0000-4000-8000-000000000001',
          environment_id: environmentId || 'windows-worker',
          workspace_id: 'projectless-test',
          workspace_kind: 'projectless',
          workspace_root: 'C:\\temp\\projectless-test',
        };
        contexts.set(context.workspace_handle, context);
        return context;
      },
      resolve(handleId) {
        return contexts.get(handleId) || {
          workspace_handle: handleId,
          environment_id: 'worker-a',
          workspace_id: 'projectless-test',
          workspace_kind: 'projectless',
          workspace_root: 'C:\\temp\\projectless-test',
        };
      },
    },
    processManager: {
      async execCommand(args) {
        calls.push(args);
        return {
          chunk_id: 'test',
          wall_time_seconds: 0.01,
          output: '{"ok":true}',
          exit_code: 0,
        };
      },
      async writeStdin(args) {
        calls.push({ writeStdin: args });
        return {
          chunk_id: 'continued-test',
          wall_time_seconds: 0.02,
          output: '',
          exit_code: 0,
        };
      },
    },
    fileService: {
      async sendFile(args) {
        calls.push({ sendFile: args });
        return {
          environment_id: 'worker-a',
          path: args.path,
          filename: 'report.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          byte_length: 4,
          sha256: 'test-sha256',
          data: Buffer.from('test').toString('base64'),
        };
      },
      async receiveFile(args) {
        calls.push({ receiveFile: args });
        return {
          environment_id: 'worker-a',
          path: 'C:\\temp\\projectless-test\\incoming.txt',
          filename: 'incoming.txt',
          mime_type: args.file.mime_type || 'application/octet-stream',
          byte_length: 4,
          sha256: 'receive-sha256',
          file_id: args.file.file_id,
        };
      },
    },
    fileTransferStore: new FileTransferStore(),
    fileDownloadOrigin: () => 'https://example.test',
  };
}

test('publish is a peer MCP tool and yields an HTTPS URL', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const publish = registry.get('ccm-extra.publish');
  assert.ok(publish);
  assert.equal(publish.mcpMeta.ui.resourceUri, PUBLISHED_FILE_UI_URI);
  assert.equal(publish.mcpMeta['openai/outputTemplate'], PUBLISHED_FILE_UI_URI);
  assert.match(publish.description, /proactively publish/i);
  assert.match(publish.description, /default 12 MiB limit/);
  assert.match(publish.description, /larger files proactively call quark_upload.*without an explicit Quark request/);
  assert.match(publish.description, /no share link is needed/);
  assert.match(publish.description, /Honor an explicitly requested delivery method/);
  assert.equal(publish.supportsParallel, false);
  assert.equal(registry.get('ccm-extra.send_file'), null);
  const args = { workspace_handle: '00000000-0000-4000-8000-000000000001', path: 'report.docx' };
  const direct = await publish.handler(args);
  assert.equal(direct.isError, undefined);
  assert.equal(direct.structuredContent.capability, 'publish');
  assert.match(direct.structuredContent.download_url, /^https:\/\/example\.test\/ccm\/download\/[0-9a-f-]+$/);
  assert.equal(direct.structuredContent.preview_url, undefined);
  assert.equal(direct.structuredContent.filename, 'report.docx');
  assert.ok(!direct.content.some((item) => item.type === 'resource_link'));
  const token = direct.structuredContent.download_url.split('/').at(-1);
  assert.equal(runtime.fileTransferStore.get(token).byte_length, 4);
  const second = await publish.handler(args);
  assert.equal(second.isError, undefined);
  assert.equal(second.structuredContent.capability, 'publish');
  assert.ok(!second.content.some((item) => item.type === 'resource_link'));
  runtime.fileTransferStore.close();
});

test('publish uses the same file UI for images and non-images', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const publish = registry.get('ccm-extra.publish');
  const bytes = Buffer.from('image-test');
  runtime.fileService.sendFile = async () => ({
    environment_id: 'worker-a', filename: 'portrait.png', mime_type: 'image/png',
    byte_length: bytes.length, sha256: 'image-sha256', data: bytes.toString('base64'),
  });
  const result = await publish.handler({
    path: 'portrait.png', workspace_handle: '00000000-0000-4000-8000-000000000001',
  });
  const token = result.structuredContent.download_url.split('/').at(-1);
  assert.equal(result.structuredContent.preview_url, 'https://example.test/ccm/preview/' + token);
  assert.equal(result.structuredContent.filename, 'portrait.png');
  assert.equal(result.structuredContent.download_url, 'https://example.test/ccm/download/' + token);
  assert.ok(runtime.fileTransferStore.get(token));
  runtime.fileTransferStore.close();
});

test('publish renders only a bounded Markdown prefix with full HTML preview link', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const content = '标题😀\n' + 'hello\n'.repeat(1900);
  const bytes = Buffer.from(content);
  runtime.fileService.sendFile = async () => ({
    environment_id: 'worker-a', filename: 'readme.md', mime_type: 'text/markdown',
    byte_length: bytes.length, data: bytes.toString('base64'),
  });
  const result = await registry.get('ccm-extra.publish').handler({
    path: 'readme.md', workspace_handle: '00000000-0000-4000-8000-000000000001',
  });
  const token = result.structuredContent.download_url.split('/').at(-1);
  assert.equal(result.structuredContent.preview_url, 'https://example.test/ccm/preview/' + token);
  assert.equal(result.structuredContent.preview_kind, 'markdown');
  assert.equal(result.structuredContent.markdown_truncated, true);
  assert.match(result.structuredContent.markdown_preview, /^<p>标题😀/);
  assert.equal(result.structuredContent.text_preview, undefined);
  assert.equal(result.structuredContent.text_url, undefined);
  runtime.fileTransferStore.close();
});

test('publish accepts exclusive Plan or Worker modes, with a complete immutable Plan snapshot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-publish-plan-'));
  const runtime = fakeRuntime();
  runtime.planManager = new PlanManager({ stateDir: dir });
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const publish = registry.get('ccm-extra.publish');
  const lines = ['# Plan 标题', ...Array.from({ length: 900 }, (_, i) => 'line ' + i + ' 😀')];
  const content = lines.join('\n');
  try {
    const { plan_id: planId } = await runtime.planManager.create([
      '*** Begin Patch', '*** Add File: plan.md',
      ...lines.map((line) => '+' + line), '*** End Patch',
    ].join('\n'));
    const bounded = await runtime.planManager.read(planId);
    assert.equal(bounded.truncated, true);
    const result = await publish.handler({ plan_id: planId });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.capability, 'publish');
    assert.equal(result.structuredContent.plan_id, planId);
    assert.equal(result.structuredContent.environment_id, undefined);
    assert.equal(result.structuredContent.filename, 'plan-' + planId + '.md');
    assert.match(result.structuredContent.mime_type, /^text\/markdown/);
    const persisted = await runtime.planManager.snapshot(planId);
    assert.equal(persisted.toString('utf8').trimEnd(), content);
    assert.equal(result.structuredContent.byte_length, persisted.length);
    assert.equal(result.structuredContent.markdown_truncated, true);
    assert.match(result.structuredContent.markdown_preview, /^<h1>Plan 标题<\/h1>/);
    assert.match(result.structuredContent.preview_url, /^https:\/\/example\.test\/ccm\/preview\//);
    const token = result.structuredContent.download_url.split('/').at(-1);
    const snapshot = runtime.fileTransferStore.acquire(token);
    assert.ok(snapshot);
    const chunks = [];
    for await (const chunk of snapshot.stream) chunks.push(chunk);
    snapshot.release();
    assert.deepEqual(Buffer.concat(chunks), persisted);

    await runtime.planManager.patch(planId, [
      '*** Begin Patch', '*** Update File: plan.md', '@@',
      '-# Plan 标题', '+# Updated Plan 标题', '*** End Patch',
    ].join('\n'));
    const updated = await publish.handler({ plan_id: planId });
    assert.notEqual(updated.structuredContent.download_url, result.structuredContent.download_url);
    assert.match(updated.structuredContent.markdown_preview, /^<h1>Updated Plan 标题<\/h1>/);
    const original = runtime.fileTransferStore.acquire(token);
    const originalChunks = [];
    for await (const chunk of original.stream) originalChunks.push(chunk);
    original.release();
    assert.deepEqual(Buffer.concat(originalChunks), persisted);
    assert.equal(runtime.calls.filter((call) => call.sendFile).length, 0);

    const workerArgs = { workspace_handle: '00000000-0000-4000-8000-000000000001', path: 'report.docx' };
    for (const invalid of [{}, { plan_id: planId, ...workerArgs }, { plan_id: planId, path: 'x' }, { path: 'x' }, { workspace_handle: workerArgs.workspace_handle }, { plan_id: 'bad' }]) {
      assert.throws(() => registry.validateArguments(publish, invalid));
    }
    assert.deepEqual(registry.validateArguments(publish, { plan_id: planId }), { plan_id: planId });
    assert.deepEqual(registry.validateArguments(publish, workerArgs), workerArgs);
    const missing = await publish.handler({ plan_id: '00000000-0000-4000-8000-000000000099' });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Unknown plan_id/);
  } finally {
    runtime.fileTransferStore.close();
    await runtime.planManager.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('import_chatgpt_file binds the native file on its own MCP tool', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const receiveFile = registry.get('ccm-extra.import_chatgpt_file');
  assert.ok(receiveFile);
  assert.equal(receiveFile.supportsParallel, false);
  assert.match(receiveFile.description, /Import exactly one ChatGPT file/i);
  assert.match(receiveFile.description, /sequential/i);
  assert.match(receiveFile.description, /multiple imports must be sequential/i);
  assert.match(receiveFile.description, /ordinary conversation attachment.*file parameter/i);
  assert.match(receiveFile.description, /Library file.*materialize.*raw_file.*file parameter/i);

  const input = {
    download_url: 'https://files.example.test/download',
    file_id: 'file_incoming',
    mime_type: 'text/plain',
    file_name: 'incoming.txt',
  };
  const result = await receiveFile.handler({
    workspace_handle: '00000000-0000-4000-8000-000000000001',
    file: input,
    destination: 'incoming.txt',
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.capability, 'import_chatgpt_file');
  assert.equal(result.structuredContent.file_id, 'file_incoming');
  assert.deepEqual(runtime.calls.at(-1), {
    receiveFile: {
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      file: input,
      destination: 'incoming.txt',
      overwrite: false,
    },
  });

  assert.deepEqual(receiveFile.mcpMeta['openai/fileParams'], ['file']);
  const second = await receiveFile.handler({
    workspace_handle: '00000000-0000-4000-8000-000000000001',
    file: input, destination: 'second-incoming.txt',
  });
  assert.equal(second.isError, undefined);
  assert.equal(runtime.calls.at(-1).receiveFile.destination, 'second-incoming.txt');
});


test('conversation tool advertises unified import and read actions', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = id => ({
    id: id || 'worker-a', platform: 'windows', capabilities: { conversation: true },
  });
  runtime.workerHub = { async call(id, method, args) {
    runtime.calls.push({ id, method, args });
    return { status: 'ok', conversation_id: 'share:' + id + ':opaque', total_items: 3 };
  } };
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const tool = registry.get('ccm-extra.conversation');
  assert.ok(tool);
  assert.match(tool.description, /Do not use web search/);
  const result = await tool.handler({
    action: 'import', share_url: 'https://chatgpt.com/share/test-id', environment_id: 'worker-a',
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.capability, 'conversation');
  assert.deepEqual(runtime.calls[0].method, 'conversation');
  assert.equal(runtime.calls[0].args.action, 'import');
  assert.equal(runtime.calls[0].args.environment_id, 'worker-a');
  const next = await tool.handler({ action: 'thread/turns/list', conversation_id: 'share:worker-a:opaque' });
  assert.equal(next.isError, undefined);
  assert.equal(runtime.calls[1].args.action, 'thread/turns/list');
  const local = await tool.handler({ action: 'thread/read', thread_id: '01a1ad26-84a2-7b91-87bc-32b31a875889' });
  assert.equal(local.isError, undefined);
  assert.equal(runtime.calls[2].args.thread_id, '01a1ad26-84a2-7b91-87bc-32b31a875889');
});

test('conversation capability guard does not invoke an old Worker or trigger quarantine', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = id => ({ id: id || 'noha', capabilities: { exec: true } });
  runtime.workerHub = { async call() { throw new Error('Worker should not be called.'); } };
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const result = await registry.get('ccm-extra.conversation').handler({
    action: 'thread/read', thread_id: '01a1ad26-84a2-7b91-87bc-32b31a875889', environment_id: 'noha',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /does not support conversation/);
});

test('quark_upload is a peer MCP tool', () => {
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, fakeRuntime());
  const quarkUpload = registry.get('ccm-extra.quark_upload');
  assert.ok(quarkUpload);
  assert.match(quarkUpload.description, /call this tool directly/i);
});

test('conversation handles Codex Share and local UUID without workspace registration', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = () => ({ id: 'worker-a', capabilities: { conversation: true } });
  runtime.workerHub = { async call(id, method, args) {
    runtime.calls.push({ id, method, args });
    return { status: 'ok', conversation_id: 'share:worker-a:sample' };
  } };
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const tool = registry.get('ccm-extra.conversation');
  assert.ok(tool.tags.includes('codex'));
  assert.match(tool.description, /https:\/\/chatgpt\.com\/s\/cx_/);
  const url = 'https://chatgpt.com/s/cx_' + 'a'.repeat(32);
  const result = await tool.handler({ action: 'import', share_url: url });
  assert.equal(result.isError, undefined);
  assert.equal(runtime.calls[0].args.share_url, url);
  assert.equal(runtime.calls[0].method, 'conversation');
});

test('Bilibili tool consumes only a local bridge handoff on 6v without exposing signed URLs', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);

  const tool = registry.get('ccm-extra.bilibili_download_dash');
  assert.match(tool.description, /BMGCTL IS REQUIRED/);
  assert.match(tool.description, /bmgctl\.cmd/);
  assert.match(tool.description, /Do not invoke BMG MCP tools/);
  assert.match(tool.description, /stop rather than silently using anonymous requests/);
  assert.match(tool.description, /Before downloading, the tool automatically pauses/);
  assert.doesNotMatch(tool.description, /IMMEDIATELY|autoplay|before doing anything else|cleanup|non-video/i);
  assert.match(tool.description, /BRIDGE IS REQUIRED/);
  assert.match(tool.description, /mode no-cors, and Content-Type text\/plain/);
  assert.match(tool.description, /Require the Bridge process to exit with BRIDGE_RECEIVED/);
  assert.equal(tool.inputSchema.video_url, undefined);
  assert.equal(tool.inputSchema.audio_url, undefined);
  assert.equal(tool.inputSchema.expected_height, undefined);
  assert.equal(tool.inputSchema.output_path.safeParse('video.mp4').success, true);
  assert.equal(tool.inputSchema.output_path.safeParse('C:\\media\\video.mp4').success, false);
  assert.equal(tool.inputSchema.output_path.safeParse('../video.mp4').success, false);
  assert.equal(tool.inputSchema.browser_tab_id.safeParse(undefined).success, false);
  assert.equal(tool.inputSchema.browser_tab_id.safeParse(0).success, false);
  assert.equal(tool.inputSchema.browser_tab_id.safeParse(2042628313).success, true);
  assert.equal(tool.inputSchema.workspace_handle.safeParse(undefined).success, true);
  assert.equal(tool.inputSchema.environment_id.safeParse('noha').success, false);
  const result = await tool
    .handler({
      environment_id: 'DESKTOP-KFL6V1F',
      output_path: 'result.mp4',
      browser_tab_id: 2042628313,
      timeout_seconds: 90,
    });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.environment_id, 'DESKTOP-KFL6V1F');
  assert.equal(
    result.structuredContent.capability,
    'bilibili_download_dash',
  );
  assert.equal(result.structuredContent.video_url, undefined);
  assert.equal(result.structuredContent.audio_url, undefined);
  assert.equal(result.structuredContent.expected_height, undefined);
  assert.match(runtime.calls[0].cmd, /download-dash\.py/);
  assert.match(runtime.calls[0].cmd, /--timeout 90/);
  assert.match(runtime.calls[0].cmd, /--browser-tab-id 2042628313/);
  assert.doesNotMatch(runtime.calls[0].cmd, /video_url|audio_url|SESSDATA/i);
  assert.equal(runtime.calls[0].workspace_handle, '00000000-0000-4000-8000-000000000001');
  assert.equal((await tool.handler({ environment_id: 'noha', output_path: 'C:\\media\\bad.mp4', browser_tab_id: 1 })).isError, true);
  assert.equal((await tool.handler({ output_path: 'missing-tab.mp4' })).isError, true);
  const existingHandle = '00000000-0000-4000-8000-000000000001';
  const reusable = await runtime.workspaceHandleManager.createProjectless('DESKTOP-KFL6V1F');
  assert.equal(reusable.workspace_handle, existingHandle);
  const reusedResult = await tool.handler({
    workspace_handle: existingHandle,
    output_path: 'projectless.mp4',
    browser_tab_id: 2042628313,
  });
  assert.equal(reusedResult.isError, undefined);
  assert.equal(runtime.calls[1].workspace_handle, existingHandle);
  assert.match(runtime.calls[1].cmd, /--projectless-handoff/);
  assert.doesNotMatch(runtime.calls[0].cmd, /--projectless-handoff/);
  assert.equal((await tool.handler({
    workspace_handle: '00000000-0000-4000-8000-000000000002',
    output_path: 'rejected.mp4',
    browser_tab_id: 2042628313,
  })).isError, true);
});
