import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeEnvironmentExecutor } from '../src/runtime/executors/native-executor.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write() {} };
  child.kill = () => {};
  return child;
}

function createHarness({ workerEnvPath } = {}) {
  const spawned = [];
  let mode = 'proxy';
  const executor = new NativeEnvironmentExecutor({
    sandboxBackend: {
      buildInvocation() {
        return { file: 'pwsh.exe', args: ['-Command', 'echo ok'], sandboxed: true };
      },
    },
    childProxyPolicy: { getMode: () => mode },
    baseEnv: {
      CCM_PROXY: 'http://127.0.0.1:7890',
      PATH: 'test-path',
    },
    ptyProxyPath: 'ccm-pty-proxy.exe',
    workerEnvPath,
    fileExists: () => true,
    spawnProcess(file, args, options) {
      spawned.push({ file, args, options });
      return fakeChild();
    },
  });
  const start = (tty = false) => executor.startProcess({
    environment: { platform: 'win32' },
    command: 'echo ok',
    cwd: 'C:\\work',
    shell: { path: 'pwsh.exe' },
    permissionProfile: 'workspace-write',
    tty,
    onData() {},
    onExit() {},
  });
  return {
    spawned,
    start,
    setMode(next) { mode = next; },
  };
}

test('native executor applies proxy/direct mode to each newly spawned process', () => {
  const harness = createHarness();

  harness.start(false);
  assert.equal(harness.spawned[0].options.env.HTTP_PROXY, 'http://127.0.0.1:7890');

  harness.setMode('direct');
  harness.start(false);
  assert.equal('CCM_PROXY' in harness.spawned[1].options.env, false);
  assert.equal('HTTP_PROXY' in harness.spawned[1].options.env, false);

  harness.setMode('proxy');
  harness.start(true);
  assert.equal(harness.spawned[2].options.env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(harness.spawned[2].file, 'ccm-pty-proxy.exe');
});

test('native executor reads machine-local CURL_CA_BUNDLE for each pipe and PTY child', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-child-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'worker.env');
  const bundle = path.join(dir, 'ca-bundle.crt');
  fs.writeFileSync(bundle, 'test certificate');
  const harness = createHarness({ workerEnvPath: config });

  harness.start();
  assert.equal('CURL_CA_BUNDLE' in harness.spawned[0].options.env, false);

  fs.writeFileSync(config, `# local CA\nCCM_ENVIRONMENT_ID=local-worker\nCURL_CA_BUNDLE=${bundle}\n`);
  harness.start();
  harness.start(true);
  assert.equal(harness.spawned[1].options.env.CURL_CA_BUNDLE, bundle);
  assert.equal(harness.spawned[2].options.env.CURL_CA_BUNDLE, bundle);

  assert.equal('CCM_ENVIRONMENT_ID' in harness.spawned[1].options.env, false);
  fs.writeFileSync(config, 'SSL_CERT_FILE=C:/invalid.pem\n');
  assert.throws(() => harness.start(), /only CCM_\* and CURL_CA_BUNDLE/);
  fs.writeFileSync(config, 'CURL_CA_BUNDLE=C:/missing-bundle.crt\n');
  assert.throws(() => harness.start(), /file not found/);

  fs.rmSync(config);
  harness.start();
  assert.equal('CURL_CA_BUNDLE' in harness.spawned[3].options.env, false);
});
