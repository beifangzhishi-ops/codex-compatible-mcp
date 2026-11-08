import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ControlledRestart, readRestartAllowlist } from '../src/controller/controlled-restart.mjs';
import { registerRestartTools } from '../src/tools/restart-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { createControllerRuntime } from '../src/controller/runtime.mjs';
import { createWorkerRuntime } from '../src/runtime/index.mjs';
import { RemoteWorkerClient } from '../src/worker/remote-worker-client.mjs';

async function withPolicy(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-controlled-restart-'));
  const file = path.join(dir, 'ccm.config.json');
  const save = (value) => fs.writeFile(file, JSON.stringify({ restart_allowlist: value }));
  await save({ controller_service_groups: ['controller-1'], workers: ['worker-a'] });
  try {
    await callback({ file, save });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('重启记录要求断开再健康连接，合并重复请求并报告超时', async () => {
  await withPolicy(async ({ file }) => {
    const hub = new EventEmitter();
    let calls = 0;
    let armed = 0;
    hub.environmentStatus = () => ({ state: 'normal' });
    hub.call = async () => { calls++; };
    const restart = new ControlledRestart({ policyFile: file, workerHub: hub,
      environmentRegistry: { resolve: () => ({ backend: 'remote-worker' }) },
      recoveryTimeoutMs: 25, armWorkerRestart: () => { armed++; },
    });
    const args = { component: 'worker', environment_id: 'worker-a' };
    const first = await restart.request(args);
    hub.emit('environment_connected', 'worker-a');
    assert.equal(restart.status(first.operation_id).state, 'requested');
    hub.emit('environment_disconnected', 'worker-a');
    assert.equal((await restart.request(args)).operation_id, first.operation_id);
    assert.equal(calls, 1);
    assert.equal(armed, 1);
    hub.emit('environment_connected', 'other');
    assert.equal(restart.status(first.operation_id).state, 'reconnecting');
    hub.emit('environment_connected', 'worker-a');
    assert.equal(restart.status(first.operation_id).state, 'recovered');
    const second = await restart.request(args);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(restart.status(second.operation_id).state, 'failed');
    assert.equal(hub.listenerCount('environment_connected'), 0);
    assert.throws(() => restart.status('missing'), /记录不存在/);
  });
});

test('restart policy accepts only exact identities and fails closed on invalid edits', async () => {
  await withPolicy(async ({ file, save }) => {
    assert.deepEqual(readRestartAllowlist(file).workers, ['worker-a']);
    for (const workers of [['*'], ['worker-a', 'worker-a'], [''], [42]]) {
      await save({ controller_service_groups: ['controller-1'], workers });
      assert.throws(() => readRestartAllowlist(file), /Invalid restart allowlist/);
    }
    await save({ controller_service_groups: [], workers: [], shell: 'powershell.exe' });
    assert.throws(() => readRestartAllowlist(file), /Invalid restart allowlist/);
    await fs.writeFile(file, '{broken');
    assert.throws(() => readRestartAllowlist(file), SyntaxError);
    await fs.unlink(file);
    assert.throws(() => readRestartAllowlist(file), /ENOENT/);
  });
});

test('restart respects identity, live connection, and immediate allowlist edits without shell dispatch', async () => {
  await withPolicy(async ({ file, save }) => {
    const calls = [];
    let healthy = true;
    const restart = new ControlledRestart({
      policyFile: file,
      controllerEnvironmentId: 'controller-1',
      requestControllerRestart: () => calls.push(['controller']),
      environmentRegistry: {
        resolve: (id) => id === 'worker-a'
          ? { id, backend: 'remote-worker' } : { id, backend: 'native' },
      },
      workerHub: {
        environmentStatus: () => ({ state: healthy ? 'normal' : 'unavailable' }),
        call: async (...args) => {
          calls.push(args);
          return { accepted: true };
        },
      },
    });
    assert.deepEqual((await restart.request({
      component: 'worker', environment_id: 'worker-a',
    })).accepted, true);
    assert.deepEqual(calls, [['worker-a', 'restart_self', {}]]);
    await assert.rejects(restart.request({ component: 'worker', environment_id: 'controller-1' }), /not allowed/);
    await assert.rejects(restart.request({ component: 'worker', environment_id: 'worker-b' }), /not allowed/);
    await assert.rejects(restart.request({ component: 'controller_service_group', environment_id: 'worker-a' }), /not allowed/);
    assert.equal((await restart.request({ component: 'controller_service_group', environment_id: 'controller-1' })).accepted, true);
    assert.deepEqual(calls[1], ['controller']);
    healthy = false;
    // 已受理的操作在断线期间也应返回原记录，不再次发送 RPC。
    assert.equal((await restart.request({ component: 'worker', environment_id: 'worker-a' })).state, 'requested');
    healthy = true;
    await save({ controller_service_groups: [], workers: [] });
    await assert.rejects(restart.request({ component: 'worker', environment_id: 'worker-a' }), /not allowed/);
    assert.equal(calls.length, 2);
  });
});

test('restart tool is a top-level peer, with strict input and no execution arguments', async () => {
  await withPolicy(async ({ file }) => {
    const runtime = {
      controlledRestart: new ControlledRestart({
        policyFile: file,
        controllerEnvironmentId: 'controller-1',
        requestControllerRestart: () => {},
      }),
    };
    const registry = new ToolRegistry();
    registerRestartTools(registry, runtime);
    const tool = registry.get('ccm.restart');
    assert.ok(registry.list().includes(tool));
    assert.deepEqual(Object.keys(tool.inputSchema.shape), ['component', 'environment_id']);
    assert.throws(() => tool.inputSchema.parse({
      component: 'worker', environment_id: 'worker-a', cmd: 'taskkill.exe /F',
    }));
    assert.throws(() => tool.inputSchema.parse({
      component: 'worker', environment_id: 'worker-a', pid: 123,
    }));
    assert.equal((await tool.handler({
      component: 'controller_service_group', environment_id: 'controller-1',
    })).structuredContent.accepted, true);
    assert.equal((await tool.handler({
      component: 'worker', environment_id: 'worker-a',
    })).isError, true);
  });
});

test('Worker restart RPC rejects parameters and unsupervised instances; acknowledges supervised ones', async () => {
  const controller = createControllerRuntime({ workerPort: 0 });
  const worker = createWorkerRuntime({
    environment: { id: 'restart-test', cwd: process.cwd(), permissionProfile: 'workspace-write' },
  });
  let restartCount = 0;
  let client;
  await controller.start();
  try {
    client = new RemoteWorkerClient({
      runtime: worker,
      workerId: 'restart-test',
      port: controller.workerHub.address.port,
      requestRestart: () => { restartCount++; },
    });
    await client.connect();
    await assert.rejects(
      controller.workerHub.call('restart-test', 'restart_self', { command: 'whoami' }),
      (error) => error?.code === 'invalid_restart_request',
    );
    assert.equal((await controller.workerHub.call('restart-test', 'restart_self')).accepted, true);
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.equal(restartCount, 1);
    await client.close();
    client = new RemoteWorkerClient({
      runtime: worker,
      workerId: 'restart-test',
      port: controller.workerHub.address.port,
    });
    await client.connect();
    await assert.rejects(
      controller.workerHub.call('restart-test', 'restart_self'),
      (error) => error?.code === 'worker_not_supervised',
    );
    assert.equal(restartCount, 1);
  } finally {
    await client?.close().catch(() => {});
    worker.close();
    await controller.close();
  }
});
