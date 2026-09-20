import test from 'node:test';
import assert from 'node:assert/strict';
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

test('specialized WCM-derived tools are deferred and searchable', () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);

  assert.deepEqual(
    registry.listDirect().map((tool) => tool.qualifiedName),
    [],
  );
  assert.deepEqual(
    registry.listDeferred().map((tool) => tool.qualifiedName).sort(),
    [
      'ccm-extra.bilibili_download_dash',
      'ccm-extra.bmg_call',
      'ccm-extra.quark_probe',
      'ccm-extra.quark_upload',
      'ccm-extra.send_file',
    ],
  );
  assert.equal(
    registry.searchDeferred('bilibili', { limit: 5 })[0].qualified_name,
    'ccm-extra.bilibili_download_dash',
  );
  assert.equal(
    registry.searchDeferred('quark upload', { limit: 5 })[0].qualified_name,
    'ccm-extra.quark_upload',
  );
  assert.equal(
    registry.searchDeferred('send file', { limit: 5 })[0].qualified_name,
    'ccm-extra.send_file',
  );
  assert.equal(
    registry.searchDeferred('bmg browser gpt', { limit: 5 })[0].qualified_name,
    'ccm-extra.bmg_call',
  );
});

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

test('quark deferred tools route through the selected Remote Worker', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);

  const probe = await registry.get('ccm-extra.quark_probe').handler({
    environment_id: 'worker-a',
  });
  assert.equal(probe.isError, undefined);
  assert.equal(probe.structuredContent.environment_id, 'worker-a');
  assert.match(runtime.calls[0].cmd, /cloud_transfer\.py/);
  assert.match(runtime.calls[0].cmd, /probe --json/);

  const upload = await registry.get('ccm-extra.quark_upload').handler({
    environment_id: 'worker-a',
    paths: ["C:\\media\\a'b.mp4", 'D:\\archive.zip'],
    timeout_seconds: 45,
    no_wait: true,
  });
  assert.equal(upload.isError, undefined);
  assert.match(runtime.calls[1].cmd, /upload/);
  assert.match(runtime.calls[1].cmd, /--timeout 45 --no-wait --json/);
  assert.match(runtime.calls[1].cmd, /a''b\.mp4/);
});

test('BMG adapter stays optional and dispatches through the external bmgctl client', async () => {
  const runtime = fakeRuntime();
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const browserArgs = { url: 'https://chatgpt.com' };
  const result = await registry.get('ccm-extra.bmg_call').handler({
    environment_id: 'worker-b',
    tool: 'chrome_navigate',
    arguments: browserArgs,
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.environment_id, 'worker-b');
  assert.equal(result.structuredContent.capability, 'bmg_call');
  assert.equal(result.structuredContent.bmg_tool, 'chrome_navigate');
  assert.match(runtime.calls[0].cmd, /CCM_BMG_CLIENT/);
  assert.match(runtime.calls[0].cmd, /bmgctl\.cmd/);
  assert.match(runtime.calls[0].cmd, /chrome_navigate/);
  assert.match(runtime.calls[0].cmd, /--args-base64/);
  const encoded = Buffer.from(JSON.stringify(browserArgs), 'utf8').toString('base64');
  assert.ok(runtime.calls[0].cmd.includes(encoded));
  assert.equal(runtime.calls[0].cmd.includes('https://chatgpt.com'), false);
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

test('specialized tools reject non-Windows environments before dispatch', async () => {
  const runtime = fakeRuntime();
  runtime.environmentRegistry.resolve = () => ({
    id: 'linux-worker',
    platform: 'linux',
  });
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);

  const result = await registry.get('ccm-extra.quark_probe').handler({
    environment_id: 'linux-worker',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires a Windows Remote Worker/);
  assert.equal(runtime.calls.length, 0);
});
