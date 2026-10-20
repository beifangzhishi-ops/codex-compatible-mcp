import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { registerSpecializedTools } from '../src/tools/specialized-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';
import { PUBLISHED_FILE_UI_URI } from '../src/ui/published-file-app.mjs';
import { registerArchitectureTools } from '../src/tools/architecture-tools.mjs';

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
    workspaceContextManager: {
      async createProjectless(environmentId = null) {
        const context = {
          workspace_context: '00000000-0000-4000-8000-000000000001',
          environment_id: environmentId || 'windows-worker',
          workspace_id: 'projectless-test',
          workspace_kind: 'projectless',
          workspace_root: 'C:\\temp\\projectless-test',
        };
        contexts.set(context.workspace_context, context);
        return context;
      },
      resolve(contextId) {
        return contexts.get(contextId) || {
          workspace_context: contextId,
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

test('publish_worker_file is Direct + Code Mode and yields an HTTPS URL through direct and exec', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const publish = registry.get('ccm-extra.publish_worker_file');
  assert.ok(publish);
  assert.equal(publish.surfaces.direct, true);
  assert.equal(publish.surfaces.codeMode, true);
  assert.equal(publish.surfaces.deferred, false);
  assert.equal(publish.mcpMeta.ui.resourceUri, PUBLISHED_FILE_UI_URI);
  assert.equal(publish.mcpMeta['openai/outputTemplate'], PUBLISHED_FILE_UI_URI);
  assert.match(publish.description, /proactively publish/i);
  assert.equal(publish.supportsParallel, false);
  assert.equal(registry.get('ccm-extra.send_file'), null);
  const args = { workspace_context: '00000000-0000-4000-8000-000000000001', path: 'report.docx' };
  const direct = await publish.handler(args);
  assert.equal(direct.isError, undefined);
  assert.equal(direct.structuredContent.capability, 'publish_worker_file');
  assert.match(direct.structuredContent.download_url, /^https:\/\/example\.test\/ccm\/download\/[0-9a-f-]+$/);
  assert.equal(direct.structuredContent.preview_url, undefined);
  assert.equal(direct.structuredContent.filename, 'report.docx');
  assert.ok(!direct.content.some((item) => item.type === 'resource_link'));
  const token = direct.structuredContent.download_url.split('/').at(-1);
  assert.equal(runtime.fileTransferStore.get(token).byte_length, 4);
  registerArchitectureTools(registry);
  const nested = await registry.get('exec').handler({ calls: [{ tool: 'ccm-extra.publish_worker_file', arguments: args }] });
  assert.equal(nested.isError, undefined);
  assert.equal(nested.structuredContent.state, 'completed');
  assert.equal(nested.structuredContent.calls[0].result.structured_content.capability, 'publish_worker_file');
  assert.ok(!nested.content.some((item) => item.type === 'resource_link'));
  const parallel = await registry.get('exec').handler({ calls: [{ tool: 'ccm-extra.publish_worker_file', arguments: args }], parallel: true });
  assert.equal(parallel.isError, true);
  runtime.fileTransferStore.close();
});

test('publish_worker_file uses the same file UI for images and non-images', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const publish = registry.get('ccm-extra.publish_worker_file');
  const bytes = Buffer.from('image-test');
  runtime.fileService.sendFile = async () => ({
    environment_id: 'worker-a', filename: 'portrait.png', mime_type: 'image/png',
    byte_length: bytes.length, sha256: 'image-sha256', data: bytes.toString('base64'),
  });
  const result = await publish.handler({
    path: 'portrait.png', workspace_context: '00000000-0000-4000-8000-000000000001',
  });
  const token = result.structuredContent.download_url.split('/').at(-1);
  assert.equal(result.structuredContent.preview_url, 'https://example.test/ccm/preview/' + token);
  assert.equal(result.structuredContent.filename, 'portrait.png');
  assert.equal(result.structuredContent.download_url, 'https://example.test/ccm/download/' + token);
  assert.ok(runtime.fileTransferStore.get(token));
  runtime.fileTransferStore.close();
});

test('publish_worker_file inlines only a bounded UTF-8 text prefix with full-text link', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const content = '标题😀\n' + 'hello\n'.repeat(1900);
  const bytes = Buffer.from(content);
  runtime.fileService.sendFile = async () => ({
    environment_id: 'worker-a', filename: 'readme.md', mime_type: 'text/markdown',
    byte_length: bytes.length, data: bytes.toString('base64'),
  });
  const result = await registry.get('ccm-extra.publish_worker_file').handler({
    path: 'readme.md', workspace_context: '00000000-0000-4000-8000-000000000001',
  });
  const token = result.structuredContent.download_url.split('/').at(-1);
  assert.equal(result.structuredContent.text_url, 'https://example.test/ccm/preview/' + token);
  assert.equal(result.structuredContent.text_truncated, true);
  assert.ok(Buffer.byteLength(result.structuredContent.text_preview) <= 8192);
  assert.match(result.structuredContent.text_preview, /^标题😀/);
  assert.equal(result.structuredContent.preview_url, undefined);
  runtime.fileTransferStore.close();
});

test('receive_file is Deferred + Code Mode and preserves native file objects through exec', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const receiveFile = registry.get('ccm-extra.import_chatgpt_file');
  assert.ok(receiveFile);
  assert.equal(receiveFile.surfaces.direct, false);
  assert.equal(receiveFile.surfaces.deferred, true);
  assert.equal(receiveFile.surfaces.codeMode, true);
  assert.equal(receiveFile.supportsParallel, false);
  assert.match(receiveFile.description, /Import exactly one ChatGPT file/i);
  assert.match(receiveFile.description, /sequential/i);
  assert.match(receiveFile.description, /multiple imports must be sequential/i);
  assert.match(receiveFile.description, /ordinary conversation attachment.*top-level file/i);
  assert.match(receiveFile.description, /Library file.*materialize.*raw_file.*top-level exec\.file/i);

  const input = {
    download_url: 'https://files.example.test/download',
    file_id: 'file_incoming',
    mime_type: 'text/plain',
    file_name: 'incoming.txt',
  };
  const result = await receiveFile.handler({
    workspace_context: '00000000-0000-4000-8000-000000000001',
    file: input,
    destination: 'incoming.txt',
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.capability, 'import_chatgpt_file');
  assert.equal(result.structuredContent.file_id, 'file_incoming');
  assert.deepEqual(runtime.calls.at(-1), {
    receiveFile: {
      workspace_context: '00000000-0000-4000-8000-000000000001',
      file: input,
      destination: 'incoming.txt',
      overwrite: false,
    },
  });

  registerArchitectureTools(registry);
  const execTool = registry.get('exec');
  assert.deepEqual(execTool.mcpMeta['openai/fileParams'], ['file']);
  const nested = await registry.get('exec').handler({
    calls: [{
      tool: 'ccm-extra.import_chatgpt_file',
      arguments: {
        workspace_context: '00000000-0000-4000-8000-000000000001',
        file: input,
        destination: 'nested-incoming.txt',
      },
    }],
  });
  assert.equal(nested.isError, undefined);
  assert.equal(nested.structuredContent.state, 'completed');
  assert.deepEqual(runtime.calls.at(-1), {
    receiveFile: {
      workspace_context: '00000000-0000-4000-8000-000000000001',
      file: input,
      destination: 'nested-incoming.txt',
      overwrite: false,
    },
  });

  const bridged = await registry.get('exec').handler({
    file: input,
    calls: [{
      tool: 'ccm-extra.import_chatgpt_file',
      arguments: {
        workspace_context: '00000000-0000-4000-8000-000000000001',
        destination: 'bridged-incoming.txt',
      },
    }],
  });
  assert.equal(bridged.isError, undefined);
  assert.equal(bridged.structuredContent.state, 'completed');
  assert.deepEqual(runtime.calls.at(-1), {
    receiveFile: {
      workspace_context: '00000000-0000-4000-8000-000000000001',
      file: input,
      destination: 'bridged-incoming.txt',
      overwrite: false,
    },
  });

  const duplicateFile = await registry.get('exec').handler({
    file: input,
    calls: [{
      tool: 'ccm-extra.import_chatgpt_file',
      arguments: {
        workspace_context: '00000000-0000-4000-8000-000000000001',
        file: input,
      },
    }],
  });
  assert.equal(duplicateFile.isError, true);
  assert.match(duplicateFile.content[0].text, /cannot be combined/i);

  const rejectedParallel = await registry.get('exec').handler({
    calls: [{
      tool: 'ccm-extra.import_chatgpt_file',
      arguments: {
        workspace_context: '00000000-0000-4000-8000-000000000001',
        file: input,
      },
    }],
    parallel: true,
  });
  assert.equal(rejectedParallel.isError, true);
  assert.match(rejectedParallel.content[0].text, /parallel-call support/i);
});


test('ChatGPT Share export dispatches through CCM exec without BMG', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = (environmentId) => ({
    id: environmentId || 'windows-worker', platform: 'windows', capabilities: { exec: true },
  });
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const shareExport = registry.get('ccm-extra.chatgpt_share_export');
  assert.equal(shareExport.surfaces.direct, false);
  assert.equal(shareExport.surfaces.deferred, true);
  assert.equal(shareExport.surfaces.codeMode, true);
  assert.match(shareExport.description, /discover this capability through tool_search and invoke it through exec rather than BMG or browser automation/i);
  const result = await registry.get('ccm-extra.chatgpt_share_export').handler({
    environment_id: 'worker-a',
    share_url: 'https://chatgpt.com/share/test-id',
    output_path: 'C:\\tmp\\share.md',
    format: 'md', branch: 'active', mode: 'full', proxy: 'http://127.0.0.1:7890',
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.capability, 'chatgpt_share_export');
  assert.match(runtime.calls[0].cmd, /chatgpt-share-export/);
  assert.match(runtime.calls[0].cmd, /127\.0\.0\.1:7890/);
  assert.equal(runtime.calls[0].cmd.includes('bmgctl'), false);
});

test('quark_upload is Deferred + Code Mode and advertises deferred routing', () => {
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, fakeRuntime());
  const quarkUpload = registry.get('ccm-extra.quark_upload');
  assert.ok(quarkUpload);
  assert.equal(quarkUpload.surfaces.direct, false);
  assert.equal(quarkUpload.surfaces.deferred, true);
  assert.equal(quarkUpload.surfaces.codeMode, true);
  assert.match(quarkUpload.description, /discover this capability through tool_search and invoke it through exec/i);
});

test('Codex share URL is discovered and dispatched by the export tool', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = () => ({ id: 'worker-a', capabilities: { exec: true } });
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const tool = registry.get('ccm-extra.chatgpt_share_export');
  assert.ok(tool.tags.includes('codex'));
  assert.match(tool.description, /https:\/\/chatgpt\.com\/s\/cx_/);
  assert.match(tool.inputSchema.share_url.description, /Codex/);
  const url = 'https://chatgpt.com/s/cx_' + 'a'.repeat(32);
  const result = await tool.handler({ share_url: url, mode: 'full', format: 'json' });
  assert.equal(result.isError, undefined);
  assert.ok(runtime.calls[0].cmd.includes(url));
  assert.match(runtime.calls[0].cmd, /--mode 'full'/);
  assert.equal(runtime.calls[0].cmd.includes('bmgctl'), false);
});

test('ChatGPT Share export can use the default Git-ignored cache output', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = (environmentId) => ({
    id: environmentId || 'windows-worker', platform: 'windows', capabilities: { exec: true },
  });
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const result = await registry.get('ccm-extra.chatgpt_share_export').handler({
    environment_id: 'worker-a',
    share_url: 'https://chatgpt.com/share/test-id',
  });
  assert.equal(result.isError, undefined);
  assert.equal(runtime.calls[0].cmd.includes(' --output '), false);
});

test('Bilibili deferred tool passes signed DASH URLs without exposing them in result metadata', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);

  const videoUrl = 'https://example.invalid/video.m4s?token=a&x=1';
  const audioUrl = 'https://example.invalid/audio.m4s?token=b&x=2';
  const result = await registry
    .get('ccm-extra.bilibili_download_dash')
    .handler({
      environment_id: 'worker-b',
      video_url: videoUrl,
      audio_url: audioUrl,
      output_path: 'C:\\media\\result.mp4',
      timeout_seconds: 90,
    });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.environment_id, 'worker-b');
  assert.equal(
    result.structuredContent.capability,
    'bilibili_download_dash',
  );
  assert.equal(result.structuredContent.video_url, undefined);
  assert.equal(result.structuredContent.audio_url, undefined);
  assert.match(runtime.calls[0].cmd, /download-dash\.ps1/);
  assert.match(runtime.calls[0].cmd, /-TimeoutSeconds 90/);
  assert.match(runtime.calls[0].cmd, /video\.m4s\?token=a&x=1/);
  assert.match(runtime.calls[0].cmd, /audio\.m4s\?token=b&x=2/);
});
