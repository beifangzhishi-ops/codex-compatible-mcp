import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeEnvironmentExecutor } from '../src/runtime/executors/native-executor.mjs';

test('Windows administrator mode uses local agent, not the Worker sandbox backend', () => {
  let captured;
  const executor = new NativeEnvironmentExecutor({
    sandboxBackend: { buildInvocation() { throw new Error('sandbox backend must not be called'); } },
    childProxyPolicy: { getMode() { return 'direct'; } },
    commandEnvironment: () => ({ Path: 'C:\\Windows\\System32', CCM_INTERNAL_TEST: 'secret' }),
    shellEnvironmentPolicy: { inherit: 'all', use_profile: false },
    administratorClient: { startProcess(request) {
      captured = request;
      return { sandboxed: false, stdinWritable: true, write() {}, kill() {} };
    } },
  });
  const result = executor.startProcess({
    environment: { platform: 'windows', cwd: 'C:\\project' },
    command: 'Write-Output hello', cwd: 'C:\\project',
    shell: { type: 'powershell', path: 'powershell.exe' },
    permissionProfile: 'admin-elevated', tty: false,
    onData() {}, onExit() {},
  });
  assert.equal(result.sandboxed, false);
  assert.equal(captured.file, 'powershell.exe');
  assert.equal(captured.cwd, 'C:\\project');
  assert.equal(captured.args.at(-1), 'Write-Output hello');
  assert.equal(typeof captured.env, 'object');
});
