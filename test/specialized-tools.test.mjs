import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { registerSpecializedTools } from '../src/tools/specialized-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';
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
  };
}

test('send_file is Deferred + Code Mode and returns one native resource link using workspace_context', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = (environmentId) => ({
    id: environmentId || 'windows-worker',
    platform: 'windows',
    capabilities: { sendFile: true },
  });
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const sendFile = registry.get('ccm-extra.send_file');
  assert.equal(sendFile.surfaces.direct, false);
  assert.equal(sendFile.surfaces.deferred, true);
  assert.equal(sendFile.surfaces.codeMode, true);
  assert.equal(sendFile.supportsParallel, false);
  assert.match(sendFile.description, /exactly one file per call/i);
  assert.match(sendFile.description, /sequentially/i);
  assert.match(sendFile.description, /never issue concurrent or parallel/i);
  assert.match(
    sendFile.description,
    /include the host-generated native ChatGPT file attachment object in the final response, not its file ID as text/i,
  );
  assert.match(sendFile.description, /1 KiB \(1024 bytes\)/i);
  assert.match(sendFile.description, /never pad, rewrite, or otherwise alter/i);
  assert.match(sendFile.inputSchema.path.description, /exactly one file path/i);
  assert.match(sendFile.inputSchema.path.description, /do not call send_file in parallel/i);
  assert.equal(sendFile.mcpMeta, undefined);

  const result = await registry.get('ccm-extra.send_file').handler({
    workspace_context: '00000000-0000-4000-8000-000000000001',
    path: 'C:\\docs\\report.docx',
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, 'text');
  const resourceLink = result.content.find(
    (item) => item.type === 'resource_link',
  );
  assert.ok(resourceLink);
  assert.equal(resourceLink.name, 'report.docx');
  assert.equal(
    resourceLink.mimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  assert.equal(resourceLink.size, 4);
  assert.equal(resourceLink._meta.sha256, 'test-sha256');
  assert.equal(resourceLink._meta.source_environment_id, 'worker-a');
  assert.equal(
    result.content.filter((item) => item.type === 'resource_link').length,
    1,
  );
  assert.equal(result.structuredContent.resource_uri, undefined);
  assert.match(resourceLink.uri, /^ccm-file:\/\/\/[0-9a-f-]+$/i);
  const token = resourceLink.uri.split('/').at(-1);
  const stored = runtime.fileTransferStore.get(token);
  assert.ok(stored);
  assert.equal(
    Buffer.from(stored.data, 'base64').toString(),
    'test',
  );
  assert.equal(result.structuredContent.filename, 'report.docx');

  registerArchitectureTools(registry);
  const sequential = await registry.get('exec').handler({
    calls: [{
      tool: 'ccm-extra.send_file',
      arguments: {
        workspace_context: '00000000-0000-4000-8000-000000000001',
        path: 'C:\\docs\\second.docx',
      },
    }],
  });
  assert.equal(sequential.isError, undefined);
  assert.equal(sequential.structuredContent.state, 'completed');
  const nestedResourceLink = sequential.content.find(
    (item) => item.type === 'resource_link',
  );
  assert.ok(nestedResourceLink);
  assert.equal(nestedResourceLink.name, 'report.docx');
  assert.equal(nestedResourceLink.size, 4);
  assert.equal(nestedResourceLink._meta.sha256, 'test-sha256');
  assert.equal(nestedResourceLink._meta.source_environment_id, 'worker-a');
  assert.deepEqual(runtime.calls.at(-1), {
    sendFile: {
      workspace_context: '00000000-0000-4000-8000-000000000001',
      path: 'C:\\docs\\second.docx',
    },
  });

  const rejected = await registry.get('exec').handler({
    calls: [{
      tool: 'ccm-extra.send_file',
      arguments: {
        workspace_context: '00000000-0000-4000-8000-000000000001',
        path: 'C:\\docs\\second.docx',
      },
    }],
    parallel: true,
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /parallel-call support/i);
});

test('receive_file is Deferred + Code Mode and preserves native file objects through exec', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const receiveFile = registry.get('ccm-extra.receive_file');
  assert.ok(receiveFile);
  assert.equal(receiveFile.surfaces.direct, false);
  assert.equal(receiveFile.surfaces.deferred, true);
  assert.equal(receiveFile.surfaces.codeMode, true);
  assert.equal(receiveFile.supportsParallel, false);
  assert.equal(receiveFile.mcpMeta, undefined);
  assert.match(receiveFile.description, /exactly one ChatGPT file per call/i);
  assert.match(receiveFile.description, /sequentially/i);
  assert.match(receiveFile.description, /Never issue concurrent or parallel/i);

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
  assert.equal(result.structuredContent.capability, 'receive_file');
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
      tool: 'ccm-extra.receive_file',
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
      tool: 'ccm-extra.receive_file',
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
      tool: 'ccm-extra.receive_file',
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
      tool: 'ccm-extra.receive_file',
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

test('ChatGPT schema refresh keeps CCM approval credentials local to the worker', async () => {
  const script = await fs.readFile(
    new URL('../tools/chatgpt-schema-refresh/refresh.ps1', import.meta.url),
    'utf8',
  );
  assert.match(script, /CCM_APPROVAL_SECRET_FILE/);
  assert.match(script, /\/ccm\/oauth\/consent/);
  assert.match(script, /PostAsync\(\$consent,\$content\)/);
  assert.match(script, /Refusing to send the CCM approval secret to an unexpected consent URL/);
  assert.equal(/Invoke-Bmg[^\n]*approval_secret/.test(script), false);
  assert.match(script, /suffix\[0\] -gt \[char\]127/);
  assert.match(script, /StartsWith\(\$Name,\[StringComparison\]::Ordinal\)/);
  assert.match(
    script,
    /function Rename-Connector[\s\S]*?Click-Element \$Connector/,
  );
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
