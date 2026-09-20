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
      'ccm-extra.quark_probe',
      'ccm-extra.quark_upload',
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
