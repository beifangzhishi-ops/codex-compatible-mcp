import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { registerSpecializedTools } from '../src/tools/specialized-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

function fakeRuntime() {
  const calls = [];
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
          path: args.path,
          filename: 'report.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          byte_length: 4,
          sha256: 'test-sha256',
          data: Buffer.from('test').toString('base64'),
        };
      },
    },
  };
}

test('send_file returns an embedded resource without changing the direct tool surface', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = (environmentId) => ({
    id: environmentId || 'windows-worker',
    platform: 'windows',
    capabilities: { sendFile: true },
  });
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);

  const result = await registry.get('ccm-extra.send_file').handler({
    environment_id: 'worker-a',
    path: 'C:\\docs\\report.docx',
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[1].type, 'resource');
  assert.equal(
    result.content[1].resource.mimeType,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  assert.equal(
    Buffer.from(result.content[1].resource.blob, 'base64').toString(),
    'test',
  );
  assert.equal(result.structuredContent.filename, 'report.docx');
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

test('one-time key link accepts a file path without exposing file contents', async () => {
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
  const result = await registry.get('ccm-extra.one_time_key_link').handler({
    environment_id: 'worker-b',
    file_path: 'C:\\secrets\\api-key.txt',
    ttl_seconds: 180,
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.one_time_url, 'https://ccm.example.test/ccm-once/random-token');
  assert.equal(result.structuredContent.expires_in_seconds, 180);
  assert.match(runtime.calls[0].cmd, /ccm-once\\start\.ps1/);
  assert.match(runtime.calls[0].cmd, /-FilePath 'C:\\secrets\\api-key\.txt'/);
  assert.match(runtime.calls[0].cmd, /-TtlSeconds 180/);
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
