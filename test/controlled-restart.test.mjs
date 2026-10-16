import test from 'node:test';
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
  const file = path.join(dir, 'allowlist.json');
  const save = (value) => fs.writeFile(file, JSON.stringify(value));
  await save({ controller_service_groups: ['controller-1'], workers: ['worker-a'] });
  try {
    await callback({ file, save });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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
    await assert.rejects(restart.request({ component: 'worker', environment_id: 'worker-a' }), /connected, healthy/);
    healthy = true;
    await save({ controller_service_groups: [], workers: [] });
    await assert.rejects(restart.request({ component: 'worker', environment_id: 'worker-a' }), /not allowed/);
    assert.equal(calls.length, 2);
  });
});

test('restart tool is Deferred, with strict input and no execution arguments', async () => {
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
    assert.equal(tool.exposure, 'Deferred');
    assert.equal(tool.surfaces.direct, false);
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
