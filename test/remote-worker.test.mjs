import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControllerRuntime } from '../src/controller/runtime.mjs';
import { createWorkerRuntime } from '../src/runtime/index.mjs';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';
import { RemoteWorkerClient } from '../src/worker/remote-worker-client.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function workerRuntime(id) {
  return createWorkerRuntime({
    environment: {
      id,
      cwd: root,
      permissionProfile: 'full-access',
    },
  });
}

test('Controller routes execution across Remote Workers', async () => {
  const controller = createControllerRuntime({ workerPort: 0 });
  const workerA = workerRuntime('worker-a');
  const workerB = workerRuntime('worker-b');
  let clientA = null;
  let clientB = null;

  await controller.start();
  const port = controller.workerHub.address.port;
  try {
    clientA = new RemoteWorkerClient({
      runtime: workerA,
      workerId: 'worker-a',
      port,
    });
    clientB = new RemoteWorkerClient({
      runtime: workerB,
      workerId: 'worker-b',
      port,
    });
    await clientA.connect();
    await clientB.connect();

    assert.equal(await controller.workerHub.waitForEnvironment('worker-a'), true);
    assert.equal(await controller.workerHub.waitForEnvironment('worker-b'), true);

    const a = await controller.processManager.execCommand({
      environment_id: 'worker-a',
      cmd: 'Write-Output WORKER_A',
    });
    const b = await controller.processManager.execCommand({
      environment_id: 'worker-b',
      cmd: 'Write-Output WORKER_B',
    });
    assert.match(a.output, /WORKER_A/);
    assert.match(b.output, /WORKER_B/);
    const first = await controller.processManager.execCommand({
      environment_id: 'worker-a',
      cmd: 'Write-Output before; Start-Sleep -Seconds 11; Write-Output after',
      yield_time_ms: 250,
    });
    assert.equal(typeof first.session_id, 'number');
    assert.match(first.output, /before/);

    const second = await controller.processManager.writeStdin({
      session_id: first.session_id,
      chars: '',
      yield_time_ms: 5000,
    });
    assert.equal(second.exit_code, 0);
    assert.match(second.output, /after/);
  } finally {
    await clientA?.close().catch(() => {});
    await clientB?.close().catch(() => {});
    workerA.close();
    workerB.close();
    await controller.close();
  }
});


test('Controller preserves remote-native path syntax', () => {
  const registry = new EnvironmentRegistry({ resolvePaths: false });
  registry.register({
    id: 'linux-remote',
    platform: 'linux',
    cwd: '/srv/project',
    workspaceRoots: ['/srv/project', '/opt/shared'],
    backend: 'remote-worker',
  });

  const environment = registry.resolve('linux-remote');
  assert.equal(environment.cwd, '/srv/project');
  assert.deepEqual(environment.workspaceRoots, ['/srv/project', '/opt/shared']);
});


test('Worker disconnect unregisters its environment', async () => {
  const controller = createControllerRuntime({ workerPort: 0 });
  const worker = workerRuntime('worker-disconnect');
  let client = null;

  await controller.start();
  try {
    client = new RemoteWorkerClient({
      runtime: worker,
      workerId: 'worker-disconnect',
      port: controller.workerHub.address.port,
    });
    await client.connect();
    assert.equal(
      controller.environmentRegistry.resolve('worker-disconnect').id,
      'worker-disconnect',
    );
    controller.processManager.sessions.set(4242, {
      environmentId: 'worker-disconnect',
      remoteSessionId: 17,
    });

    await client.close();
    for (let index = 0; index < 50; index += 1) {
      if (!controller.environmentRegistry.environments.has('worker-disconnect')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      controller.environmentRegistry.environments.has('worker-disconnect'),
      false,
    );
    assert.equal(controller.processManager.sessions.has(4242), false);
  } finally {
    await client?.close().catch(() => {});
    worker.close();
    await controller.close();
  }
});
