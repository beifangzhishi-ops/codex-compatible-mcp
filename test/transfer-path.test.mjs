import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkerTransferService } from '../src/runtime/filesystem/transfer-worker.mjs';
import { TransferTaskManager } from '../src/controller/transfer-task-manager.mjs';
import { createWorkerRuntime } from '../src/runtime/index.mjs';
import { createControllerRuntime } from '../src/controller/runtime.mjs';
import { RemoteWorkerClient } from '../src/worker/remote-worker-client.mjs';

async function harness(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transfer-test-'));
  const src = path.join(dir, 'src'), dst = path.join(dir, 'dst');
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  const services = new Map([
    ['source', new WorkerTransferService({ workspaceRegistry: {
      environmentFor(id, root) {
        assert.equal(id, 'source-ws');
        assert.equal(root, src);
        return { cwd: src };
      },
    } })],
    ['target', new WorkerTransferService({ workspaceRegistry: {
      environmentFor(id, root) {
        assert.equal(id, 'target-ws');
        assert.equal(root, dst);
        return { cwd: dst };
      },
    } })],
  ]);
  const handles = new Map([
    ['source-handle', { environment_id: 'source', workspace_id: 'source-ws', workspace_root: src }],
    ['target-handle', { environment_id: 'target', workspace_id: 'target-ws', workspace_root: dst }],
  ]);
  const manager = new TransferTaskManager({
    workspaceHandleManager: { resolve: id => {
      if (!handles.has(id)) throw new Error('Invalid workspace handle');
      return handles.get(id);
    } },
    workerHub: {
      call: async (environmentId, method, args) => {
        const svc = services.get(environmentId);
        if (!svc) throw new Error('Unknown worker');
        return svc[method.replace(/^transfer_/, '')](args);
      },
    },
  });
  async function copy(sourcePath, targetPath) {
    const started = manager.start({
      source_handle: 'source-handle', source_path: sourcePath,
      target_handle: 'target-handle', target_path: targetPath,
    });
    await manager.tasks.get(started.transfer_id).promise;
    return manager.status(started.transfer_id);
  }
  try { await callback({ src, dst, manager, services, copy }); }
  finally { await manager.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('WorkerHub task copies a file larger than one chunk and verifies bytes', async () => {
  await harness(async ({ src, dst, copy }) => {
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 13);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    fs.writeFileSync(path.join(src, 'large.bin'), bytes);
    const result = await copy('large.bin', 'out/large.bin');
    assert.equal(result.state, 'completed', result.error);
    assert.equal(result.transferred_bytes, bytes.length);
    assert.deepEqual(fs.readFileSync(path.join(dst, 'out', 'large.bin')), bytes);
  });
});

test('WorkerHub task preserves directories, empty files, and unicode names', async () => {
  await harness(async ({ src, dst, copy }) => {
    fs.mkdirSync(path.join(src, 'folder'));
    fs.mkdirSync(path.join(src, 'folder', 'empty'));
    fs.writeFileSync(path.join(src, 'folder', '你好.txt'), '你好');
    fs.writeFileSync(path.join(src, 'folder', 'zero.bin'), '');
    const result = await copy('folder', 'deep/copied');
    assert.equal(result.state, 'completed', result.error);
    assert.equal(result.file_count, 2);
    assert.equal(fs.readFileSync(path.join(dst, 'deep/copied/你好.txt'), 'utf8'), '你好');
    assert.equal(fs.readFileSync(path.join(dst, 'deep/copied/zero.bin')).length, 0);
    assert.ok(fs.statSync(path.join(dst, 'deep/copied/empty')).isDirectory());
  });
});

test('existing target refuses transfer with source left intact', async () => {
  await harness(async ({ src, dst, copy }) => {
    fs.writeFileSync(path.join(src, 'source.txt'), 'new');
    fs.writeFileSync(path.join(dst, 'existing.txt'), 'old');
    const result = await copy('source.txt', 'existing.txt');
    assert.equal(result.state, 'failed');
    assert.match(result.error, /already exists/);
    assert.equal(result.transferred_bytes, 0);
    assert.equal(fs.readFileSync(path.join(dst, 'existing.txt'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(src, 'source.txt'), 'utf8'), 'new');
  });
});

test('cancellation removes only objects created by transfer', async () => {
  await harness(async ({ src, dst, manager }) => {
    fs.writeFileSync(path.join(src, 'source.txt'), 'new');
    const first = manager.start({
      source_handle: 'source-handle', source_path: 'source.txt',
      target_handle: 'target-handle', target_path: 'cancelled.txt',
    });
    manager.cancel(first.transfer_id);
    await manager.tasks.get(first.transfer_id).promise;
    assert.equal(manager.status(first.transfer_id).state, 'cancelled');
    assert.equal(fs.existsSync(path.join(dst, 'cancelled.txt')), false);
  });
});

test('real WorkerHub TCP RPC transfers multiple chunks between two Workers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-hub-transfer-'));
  const src = path.join(root, 'source');
  const dst = path.join(root, 'target');
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  const payload = Buffer.alloc(4 * 1024 * 1024 + 99, 0x5d);
  fs.writeFileSync(path.join(src, 'payload.bin'), payload);
  const controller = createControllerRuntime({ workerPort: 0 });
  const a = createWorkerRuntime({ environment: { id: 'transfer-worker-a', cwd: src, permissionProfile: 'workspace-write' } });
  const b = createWorkerRuntime({ environment: { id: 'transfer-worker-b', cwd: dst, permissionProfile: 'workspace-write' } });
  let clientA, clientB;
  try {
    await controller.start();
    const port = controller.workerHub.address.port;
    clientA = new RemoteWorkerClient({ runtime: a, workerId: 'transfer-worker-a', port });
    clientB = new RemoteWorkerClient({ runtime: b, workerId: 'transfer-worker-b', port });
    await clientA.connect();
    await clientB.connect();
    const contexts = new Map([
      ['src', {
        environment_id: 'transfer-worker-a',
        workspace_id: a.workspaceRegistry.listRegistered()[0].workspace_id,
        workspace_root: src,
      }],
      ['dst', {
        environment_id: 'transfer-worker-b',
        workspace_id: b.workspaceRegistry.listRegistered()[0].workspace_id,
        workspace_root: dst,
      }],
    ]);
    const manager = new TransferTaskManager({
      workspaceHandleManager: { resolve: key => contexts.get(key) },
      workerHub: controller.workerHub,
    });
    const transfer = manager.start({
      source_handle: 'src', source_path: 'payload.bin',
      target_handle: 'dst', target_path: 'copied.bin',
    });
    await manager.tasks.get(transfer.transfer_id).promise;
    assert.equal(manager.status(transfer.transfer_id).state, 'completed',
      manager.status(transfer.transfer_id).error);
    assert.deepEqual(fs.readFileSync(path.join(dst, 'copied.bin')), payload);
    await manager.close();
  } finally {
    await clientB?.close().catch(() => {});
    await clientA?.close().catch(() => {});
    a.close();
    b.close();
    await controller.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Worker restart safely recovers an owned partial file without touching other files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transfer-recovery-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'unrelated.txt'), 'keep');
  const workspaceRegistry = {
    environmentFor(id, expectedRoot) {
      assert.equal(expectedRoot, workspace);
      return { cwd: workspace, permissionProfile: 'workspace-write' };
    },
  };
  try {
    const service = new WorkerTransferService({ workspaceRegistry, stateDir });
    const id = crypto.randomUUID();
    service.reserve({
      workspace_id: 'test', expected_workspace_root: workspace,
      transfer_id: id, target_path: 'new/subfolder/file.txt',
      kind: 'file', entries: [{ path: '', type: 'file', size: 10 }],
    });
    service.write({ transfer_id: id, index: 0, offset: 0, data: Buffer.from('hello').toString('base64') });
    assert.equal(fs.readFileSync(path.join(workspace, 'new/subfolder/file.txt'), 'utf8'), 'hello');
    new WorkerTransferService({ workspaceRegistry, stateDir });
    assert.equal(fs.existsSync(path.join(workspace, 'new')), false);
    assert.equal(fs.readFileSync(path.join(workspace, 'unrelated.txt'), 'utf8'), 'keep');
    assert.equal(fs.readdirSync(stateDir).length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('Worker restart preserves externally changed file instead of deleting it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transfer-residue-'));
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(workspace);
  const workspaceRegistry = {
    environmentFor() { return { cwd: workspace, permissionProfile: 'workspace-write' }; },
  };
  try {
    const service = new WorkerTransferService({ workspaceRegistry, stateDir });
    const id = crypto.randomUUID();
    service.reserve({
      workspace_id: 'test', expected_workspace_root: workspace,
      transfer_id: id, target_path: 'protected.txt',
      kind: 'file', entries: [{ path: '', type: 'file', size: 20 }],
    });
    service.write({ transfer_id: id, index: 0, offset: 0, data: Buffer.from('original').toString('base64') });
    fs.writeFileSync(path.join(workspace, 'protected.txt'), 'external modification');
    new WorkerTransferService({ workspaceRegistry, stateDir });
    assert.equal(fs.readFileSync(path.join(workspace, 'protected.txt'), 'utf8'), 'external modification');
    assert.equal(fs.readdirSync(stateDir).filter(p => p.endsWith('.json')).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('target read-only profile prevents even a root reservation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-transfer-readonly-'));
  try {
    const svc = new WorkerTransferService({ workspaceRegistry: {
      environmentFor() { return { cwd: root, permissionProfile: 'read-only' }; },
    } });
    assert.throws(() => svc.reserve({
      transfer_id: crypto.randomUUID(), target_path: 'forbidden.txt',
      workspace_id: 'x', expected_workspace_root: root,
      kind: 'file', entries: [{ path: '', type: 'file', size: 1 }],
    }), /read-only/);
    assert.equal(fs.existsSync(path.join(root, 'forbidden.txt')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
