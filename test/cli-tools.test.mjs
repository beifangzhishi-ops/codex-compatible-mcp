import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { registerCliTools } from '../src/tools/cli-tools.mjs';
import { resolveCliInvocation, runCliPassthrough } from '../src/worker/cli-passthrough.mjs';

const SIX_V = 'DESKTOP-KFL6V1F';

function fakeController() {
  const calls = [];
  const runtime = {
    environmentRegistry: {
      resolve(id) {
        return { id, platform: 'windows' };
      },
    },
    workerHub: {
      async call(...args) {
        calls.push(args);
        return { stdout: '{"hello":"世界"}\r\n', stderr: '', exit_code: 0 };
      },
    },
  };
  const registry = registerCliTools(new ToolRegistry(), runtime);
  return { calls, runtime, registry };
}

test('four CLI passthrough tools are independent peer MCP tools', async () => {
  const { calls, registry } = fakeController();
  assert.deepEqual(registry.list().map(t => t.name), ['qq', 'wechat', 'sjtu_mail', 'transcribe']);
  for (const tool of registry.list()) {
    assert.equal(tool.namespace, 'ccm-extra');
    assert.equal(tool.inputSchema.args.safeParse(['--help']).success, true);
    assert.equal(tool.inputSchema.args.safeParse('--help').success, false);
    assert.equal(tool.inputSchema.args.safeParse(['a', 1]).success, false);
  }
  const result = await registry.get('qq').handler({ args: ['recent', 'count=10'] });
  assert.equal(result.content[0].text, '{"hello":"世界"}\r\n');
  assert.equal(result.structuredContent.stdout, '{"hello":"世界"}\r\n');
  assert.equal(calls[0][0], SIX_V);
  assert.equal(calls[0][1], 'cli_passthrough');
  assert.deepEqual(calls[0][2], {
    tool: 'qq', args: ['recent', 'count=10'],
    timeout_seconds: 120, environment_id: SIX_V,
  });
  assert.equal(registry.get('transcribe').description.includes('Faster Whisper'), true);
  await registry.get('transcribe').handler({
    environment_id: 'noha', args: ['D:\\audio.wav', '--language', 'ja'],
  });
  assert.equal(calls[1][0], 'noha');
  assert.equal(calls[1][2].timeout_seconds, 3600);
});

test('CLI result and error output are returned byte-for-byte as UTF-8 text', async () => {
  const { registry, runtime } = fakeController();
  runtime.workerHub.call = async () => ({
    stdout: 'line1\r\nline2\n',
    stderr: 'error: 失败\r\n',
    exit_code: 42,
  });
  const result = await registry.get('wechat').handler({ args: ['chats'] });
  assert.deepEqual(result.content.map(c => c.text), [
    'line1\r\nline2\n', 'error: 失败\r\n',
  ]);
  assert.equal(result.structuredContent.exit_code, 42);
  assert.equal(result.isError, true);
  runtime.workerHub.call = async () => ({ missing: true, stdout: '', stderr: '', exit_code: null });
  const missing = await registry.get('sjtu_mail').handler({ args: ['--help'] });
  assert.deepEqual(missing.content, [{ type: 'text', text: '不存在' }]);
  assert.equal(missing.isError, true);
});

test('resolveCliInvocation pins fixed executables and never interprets argument tokens as shell code', () => {
  const cmd = resolveCliInvocation('qq', ['recent', 'count=10', '; rm -rf /'], {
    environmentId: SIX_V, platform: 'win32',
  });
  assert.match(cmd.executable, /QQBridge\\qq\.exe$/);
  assert.deepEqual(cmd.argv, ['recent', 'count=10', '; rm -rf /']);
  assert.throws(() => resolveCliInvocation('wechat', [], {
    environmentId: 'noha', platform: 'win32',
  }), /only on 6v/);
  assert.throws(() => resolveCliInvocation('other', [], {
    environmentId: SIX_V, platform: 'win32',
  }), /Unknown CLI/);
  const transcript = resolveCliInvocation('transcribe', ['D:\\sample.wav'], {
    environmentId: 'noha', platform: 'win32',
  });
  assert.equal(transcript.argv[0], '-3.9');
  assert.match(transcript.argv[3], /transcribe\.py$/);
});

function fakeSpawn(output = { stdout: '', stderr: '', exit_code: 0 }) {
  let options;
  let executable;
  let argv;
  const spawnProcess = (exe, args, opts) => {
    executable = exe;
    argv = args;
    options = opts;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.end(Buffer.from(output.stdout));
      child.stderr.end(Buffer.from(output.stderr));
      child.emit('close', output.exit_code, null);
    });
    return child;
  };
  return { spawnProcess, getCall: () => ({ executable, argv, options }) };
}

test('Worker CLI runner invokes a fixed executable without a shell and preserves both pipes', async () => {
  const { spawnProcess, getCall } = fakeSpawn({
    stdout: '{"message":"你好"}\r\n', stderr: 'warning\n', exit_code: 7,
  });
  const result = await runCliPassthrough({
    tool: 'qq', args: ['help'], environment_id: SIX_V,
  }, { executableExists: () => true, spawnProcess });
  assert.equal(result.stdout, '{"message":"你好"}\r\n');
  assert.equal(result.stderr, 'warning\n');
  assert.equal(result.exit_code, 7);
  assert.equal(getCall().options.shell, false);
  assert.equal(getCall().options.windowsHide, true);
  assert.equal(Object.keys(getCall().options.env).some(k => k.startsWith('CCM_')), false);
  assert.deepEqual(getCall().argv, ['help']);
});

test('Worker CLI runner returns missing for absent target or missing executable at spawn', async () => {
  const args = { tool: 'qq', args: [], environment_id: SIX_V };
  const absent = await runCliPassthrough(args, { executableExists: () => false });
  assert.equal(absent.missing, true);
  const missingAtSpawn = await runCliPassthrough(args, {
    executableExists: () => true,
    spawnProcess() {
      const error = new Error('file missing');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(missingAtSpawn.missing, true);
});
