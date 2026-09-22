import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControllerRuntime } from '../src/controller/runtime.mjs';
import { createWorkerRuntime } from '../src/runtime/index.mjs';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';
import { RemoteWorkerClient } from '../src/worker/remote-worker-client.mjs';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function workerRuntime(
  id,
  { cwd = root, permissionProfile = 'full-access' } = {},
) {
  return createWorkerRuntime({
    environment: {
      id,
      cwd,
      permissionProfile,
    },
  });
}

test('Remote Worker connect rejects when the socket closes before hello_ack', async () => {
  const runtime = workerRuntime('worker-close-before-ack');
  const server = net.createServer((socket) => {
    socket.once('data', () => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new RemoteWorkerClient({
    runtime,
    workerId: 'worker-close-before-ack',
    port: server.address().port,
    handshakeTimeoutMs: 1_000,
  });
  try {
    await assert.rejects(
      client.connect(),
      /connection closed before hello_ack/i,
    );
  } finally {
    await client.close().catch(() => {});
    runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Remote Worker connect times out when hello_ack never arrives', async () => {
  const runtime = workerRuntime('worker-hello-timeout');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new RemoteWorkerClient({
    runtime,
    workerId: 'worker-hello-timeout',
    port: server.address().port,
    handshakeTimeoutMs: 50,
  });
  try {
    await assert.rejects(
      client.connect(),
      /hello_ack timed out after 50 ms/i,
    );
  } finally {
    await client.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Controller rejects a duplicate worker id without replacing the active worker', async () => {
  const controller = createControllerRuntime({ workerPort: 0 });
  const firstRuntime = workerRuntime('worker-duplicate');
  const secondRuntime = workerRuntime('worker-duplicate');
  let firstClient = null;
  let secondClient = null;

  await controller.start();
  try {
    firstClient = new RemoteWorkerClient({
      runtime: firstRuntime,
      workerId: 'worker-duplicate',
      port: controller.workerHub.address.port,
    });
    secondClient = new RemoteWorkerClient({
      runtime: secondRuntime,
      workerId: 'worker-duplicate',
      port: controller.workerHub.address.port,
    });
    await firstClient.connect();
    await assert.rejects(
      secondClient.connect(),
      (error) => error?.code === 'duplicate_worker_id',
    );

    assert.equal(firstClient.connected, true);
    assert.equal(
      controller.environmentRegistry.resolve('worker-duplicate').id,
      'worker-duplicate',
    );
  } finally {
    await firstClient?.close().catch(() => {});
    await secondClient?.close().catch(() => {});
    firstRuntime.close();
    secondRuntime.close();
    await controller.close();
  }
});

test('Controller-owned worker can take over a stale duplicate identity', async () => {
  const takeoverToken = 'test-controller-takeover-token';
  const controller = createControllerRuntime({
    workerPort: 0,
    workerTakeoverToken: takeoverToken,
  });
  const staleRuntime = workerRuntime('worker-takeover');
  const ownedRuntime = workerRuntime('worker-takeover');
  let staleClient = null;
  let ownedClient = null;

  await controller.start();
  try {
    staleClient = new RemoteWorkerClient({
      runtime: staleRuntime,
      workerId: 'worker-takeover',
      port: controller.workerHub.address.port,
    });
    await staleClient.connect();

    ownedClient = new RemoteWorkerClient({
      runtime: ownedRuntime,
      workerId: 'worker-takeover',
      takeoverToken,
      port: controller.workerHub.address.port,
    });
    await ownedClient.connect();

    for (let index = 0; index < 50 && staleClient.connected; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(staleClient.connected, false);
    assert.equal(ownedClient.connected, true);

    await assert.rejects(
      staleClient.connect(),
      (error) => error?.code === 'duplicate_worker_id',
    );
    assert.equal(ownedClient.connected, true);
  } finally {
    await staleClient?.close().catch(() => {});
    await ownedClient?.close().catch(() => {});
    staleRuntime.close();
    ownedRuntime.close();
    await controller.close();
  }
});

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
      cmd: 'Write-Output before; Start-Sleep -Seconds 3; Write-Output after',
      yield_time_ms: 250,
    });
    assert.equal(typeof first.session_id, 'number');

    const second = await controller.processManager.writeStdin({
      session_id: first.session_id,
      chars: '',
      yield_time_ms: 5000,
    });
    assert.equal(second.exit_code, 0);
    assert.match(first.output + second.output, /before/);
    assert.match(first.output + second.output, /after/);
  } finally {
    await clientA?.close().catch(() => {});
    await clientB?.close().catch(() => {});
    workerA.close();
    workerB.close();
    await controller.close();
  }
});

test('Controller caps initial Remote Worker exec waits at five seconds', async () => {
  const registry = new EnvironmentRegistry({ resolvePaths: false });
  registry.register({
    id: 'worker-cap',
    platform: 'windows',
    cwd: 'C:\\workspace',
    workspaceRoots: ['C:\\workspace'],
    permissionProfile: 'full-access',
    backend: 'remote-worker',
  });

  class FakeWorkerHub extends EventEmitter {
    async call(environmentId, method, args, options) {
      assert.equal(environmentId, 'worker-cap');
      assert.equal(method, 'exec_command');
      assert.equal(args.yield_time_ms, 5_000);
      assert.equal(options.timeoutMs, 15_000);
      return {
        chunk_id: 'fake',
        wall_time_seconds: 5,
        output: '',
        session_id: 42,
      };
    }
  }

  const manager = new RemoteProcessManager({
    environmentRegistry: registry,
    workerHub: new FakeWorkerHub(),
  });
  try {
    const result = await manager.execCommand({
      environment_id: 'worker-cap',
      cmd: 'long-running command',
      yield_time_ms: 30_000,
    });
    assert.equal(typeof result.session_id, 'number');
  } finally {
    await manager.close();
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

test('Controller can reserve a stable default environment before workers connect', async () => {
  const controller = createControllerRuntime({
    workerPort: 0,
    defaultEnvironmentId: 'worker-local',
  });
  const remoteFirst = workerRuntime('worker-remote');
  const localSecond = workerRuntime('worker-local');
  let remoteClient = null;
  let localClient = null;

  await controller.start();
  const port = controller.workerHub.address.port;
  try {
    remoteClient = new RemoteWorkerClient({
      runtime: remoteFirst,
      workerId: 'worker-remote',
      port,
    });
    localClient = new RemoteWorkerClient({
      runtime: localSecond,
      workerId: 'worker-local',
      port,
    });
    await remoteClient.connect();
    await localClient.connect();
    assert.equal(
      await controller.workerHub.waitForEnvironment('worker-local'),
      true,
    );
    assert.equal(controller.environmentRegistry.defaultEnvironmentId, 'worker-local');
    assert.equal(controller.environmentRegistry.resolve().id, 'worker-local');
  } finally {
    await remoteClient?.close().catch(() => {});
    await localClient?.close().catch(() => {});
    remoteFirst.close();
    localSecond.close();
    await controller.close();
  }
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


test('Remote Worker owns apply_patch, view_image, and send_file filesystem work', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-worker-files-'));
  const controller = createControllerRuntime({ workerPort: 0 });
  const worker = workerRuntime('worker-files', {
    cwd: tempRoot,
    permissionProfile: 'workspace-write',
  });
  let client = null;

  await controller.start();
  try {
    client = new RemoteWorkerClient({
      runtime: worker,
      workerId: 'worker-files',
      port: controller.workerHub.address.port,
    });
    await client.connect();
    assert.equal(await controller.workerHub.waitForEnvironment('worker-files'), true);

    const patch = [
      '*** Begin Patch',
      '*** Environment ID: worker-files',
      '*** Add File: remote.txt',
      '+hello from worker',
      '*** End Patch',
    ].join('\n');
    const patchResult = await controller.fileService.applyPatch({ patch });
    assert.match(patchResult.output, /A remote\.txt/);
    assert.equal(
      await fs.readFile(path.join(tempRoot, 'remote.txt'), 'utf8'),
      'hello from worker\n',
    );

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2F+QAAAAASUVORK5CYII=',
      'base64',
    );
    await fs.writeFile(path.join(tempRoot, 'tiny.png'), png);
    const image = await controller.fileService.viewImage({
      environment_id: 'worker-files',
      path: 'tiny.png',
    });
    assert.equal(image.mime_type, 'image/png');
    assert.equal(image.width, 1);
    assert.equal(image.height, 1);
    assert.equal(Buffer.from(image.data, 'base64').length, png.length);

    const docBytes = Buffer.from('fake-docx-content');
    await fs.writeFile(path.join(tempRoot, 'sample.docx'), docBytes);
    const file = await controller.fileService.sendFile({
      environment_id: 'worker-files',
      path: 'sample.docx',
    });
    assert.equal(file.filename, 'sample.docx');
    assert.equal(
      file.mime_type,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.deepEqual(Buffer.from(file.data, 'base64'), docBytes);
  } finally {
    await client?.close().catch(() => {});
    worker.close();
    await controller.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
