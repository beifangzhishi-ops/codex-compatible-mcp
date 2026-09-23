import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { registerSpecializedTools } from '../src/tools/specialized-tools.mjs';
import { SEND_FILE_UI_URI } from '../src/ui/send-file-app.mjs';
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

test('send_file is direct and returns a readable resource link using workspace_context', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = (environmentId) => ({
    id: environmentId || 'windows-worker',
    platform: 'windows',
    capabilities: { sendFile: true },
  });
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const sendFile = registry.get('ccm-extra.send_file');
  assert.equal(sendFile.surfaces.direct, true);
  assert.equal(sendFile.surfaces.codeMode, true);
  assert.equal(sendFile.supportsParallel, false);
  assert.match(sendFile.description, /exactly one file per call/i);
  assert.match(sendFile.description, /sequentially/i);
  assert.match(sendFile.description, /never issue concurrent or parallel/i);
  assert.match(sendFile.inputSchema.path.description, /exactly one file path/i);
  assert.match(sendFile.inputSchema.path.description, /do not call send_file in parallel/i);
  assert.equal(
    sendFile.mcpMeta.ui.resourceUri,
    SEND_FILE_UI_URI,
  );
  assert.equal(
    sendFile.mcpMeta['openai/outputTemplate'],
    SEND_FILE_UI_URI,
  );

  const result = await registry.get('ccm-extra.send_file').handler({
    workspace_context: '00000000-0000-4000-8000-000000000001',
    path: 'C:\\docs\\report.docx',
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[1].type, 'resource_link');
  assert.equal(
    result.content[1].mimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  assert.equal(result.content[1].size, 4);
  assert.match(result.content[1].uri, /^ccm-file:\/\/\/[0-9a-f-]+$/i);
  const token = result.content[1].uri.split('/').at(-1);
  const stored = runtime.fileTransferStore.get(token);
  assert.ok(stored);
  assert.equal(
    Buffer.from(stored.data, 'base64').toString(),
    'test',
  );
  assert.equal(result.structuredContent.filename, 'report.docx');
  assert.equal(result.structuredContent.resource_uri, result.content[1].uri);

  registerArchitectureTools(registry);
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
  assert.match(rejected.content[0].text, /parallel-call support/);

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
});

test('receive_file is Direct-only and advertises a native ChatGPT file parameter', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const receiveFile = registry.get('ccm-extra.receive_file');
  assert.ok(receiveFile);
  assert.equal(receiveFile.surfaces.direct, true);
  assert.equal(receiveFile.surfaces.codeMode, false);
  assert.equal(receiveFile.supportsParallel, false);
  assert.deepEqual(receiveFile.mcpMeta['openai/fileParams'], ['file']);
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

test('one-time key link accepts separate descriptor paths without reconstructing target path', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  runtime.calls.length = 0;
  runtime.processManager.execCommand = async (args) => {
    runtime.calls.push(args);
    return {
      output: 'https://ccm.example.test/ccm-once/random-token\r\n',
      exit_code: 0,
    };
  };
  const result = await registry.get('ccm-extra.one_time_link').handler({
    environment_id: 'worker-b',
    directory_file_path: 'C:\\temp\\directory.txt',
    filename_file_path: 'C:\\temp\\filename.txt',
    ttl_seconds: 180,
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.one_time_url, 'https://ccm.example.test/ccm-once/random-token');
  assert.equal(result.structuredContent.expires_in_seconds, 180);
  assert.match(runtime.calls[0].cmd, /ccm-once\\start\.ps1/);
  assert.match(runtime.calls[0].cmd, /-DirectoryFilePath 'C:\\temp\\directory\.txt'/);
  assert.match(runtime.calls[0].cmd, /-FilenameFilePath 'C:\\temp\\filename\.txt'/);
  assert.match(runtime.calls[0].cmd, /-TtlSeconds 180/);
  assert.equal(runtime.calls[0].cmd.includes('C:\\secrets\\api-key.txt'), false);
  assert.equal(runtime.calls[0].cmd.includes('-FilePath'), false);
  assert.equal(runtime.calls[0].cmd.includes('powershell.exe'), false);
});

test('one-time key link schema requires descriptor paths and documents separate operations', () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const tool = registry.get('ccm-extra.one_time_link');
  assert.equal(Object.hasOwn(tool.inputSchema, 'file_path'), false);
  assert.equal(Object.hasOwn(tool.inputSchema, 'directory_file_path'), true);
  assert.equal(Object.hasOwn(tool.inputSchema, 'filename_file_path'), true);
  assert.match(tool.description, /standalone command\/tool call/);
  assert.match(tool.description, /Do not combine/);
});

test('one-time target resolver validates descriptor files and leaf filenames locally', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only one-time-link resolver');
    return;
  }

  const execFileAsync = promisify(execFile);
  const root = await fs.mkdtemp(path.join(process.cwd(), '.tmp-ccm-once-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directoryDescriptor = path.join(root, 'directory.txt');
  const filenameDescriptor = path.join(root, 'filename.txt');
  const target = path.join(root, 'target.txt');
  const resolverPath = fileURLToPath(new URL('../tools/ccm-once/resolve-target.ps1', import.meta.url));

  await fs.writeFile(target, 'test-only');
  await fs.writeFile(directoryDescriptor, root);
  await fs.writeFile(filenameDescriptor, 'target.txt');

  const invoke = async (
    dirFile = directoryDescriptor,
    nameFile = filenameDescriptor,
  ) => execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    resolverPath,
    '-DirectoryFilePath',
    dirFile,
    '-FilenameFilePath',
    nameFile,
  ]);

  let resolved;
  try {
    resolved = await invoke();
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('CCM restricted sandbox blocks child-process spawning');
      return;
    }
    throw error;
  }
  assert.equal(resolved.stdout.trim().toLowerCase(), target.toLowerCase());

  await fs.writeFile(filenameDescriptor, '..\\target.txt');
  await assert.rejects(invoke(), /leaf filename/);

  await fs.writeFile(filenameDescriptor, '');
  await assert.rejects(invoke(), /Filename descriptor is empty/);

  await fs.writeFile(filenameDescriptor, 'target.txt\nother.txt');
  await assert.rejects(invoke(), /exactly one value/);

  await assert.rejects(
    invoke(path.join(root, 'missing-directory.txt'), filenameDescriptor),
    /Directory descriptor file is unavailable/,
  );
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
