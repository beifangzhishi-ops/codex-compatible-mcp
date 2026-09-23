import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';
import { RemoteFileService } from '../src/runtime/filesystem/remote-file-service.mjs';
import { NativeFileService } from '../src/runtime/filesystem/native-file-service.mjs';

const CONTEXT_ID = '00000000-0000-4000-8000-000000000001';

function environmentRegistry() {
  return {
    resolve(environmentId = null) {
      const id = environmentId || 'worker-a';
      return {
        id,
        permissionProfile: 'workspace-write',
        capabilities: {
          exec: true,
          applyPatch: true,
          viewImage: true,
          sendFile: true,
          receiveFile: true,
        },
      };
    },
  };
}

function workspaceContextManager() {
  return {
    resolve(contextId) {
      assert.equal(contextId, CONTEXT_ID);
      return {
        workspace_context: CONTEXT_ID,
        environment_id: 'worker-a',
        workspace_id: 'projectless-test',
        workspace_kind: 'projectless',
        workspace_root: 'C:\\Users\\test\\Documents\\CCM\\projectless-test',
      };
    },
  };
}

class FakeWorkerHub extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  async call(environmentId, method, params) {
    this.calls.push({ environmentId, method, params });
    if (method === 'send_file') {
      return {
        path: params.path,
        filename: 'outside.pdf',
        mime_type: 'application/pdf',
        byte_length: 1,
        sha256: 'test',
        data: 'AA==',
      };
    }
    if (method === 'receive_file') {
      return {
        path: params.destination,
        filename: path.basename(params.destination || 'incoming.txt'),
        mime_type: params.file.mime_type || 'application/octet-stream',
        byte_length: 4,
        sha256: 'received',
        file_id: params.file.file_id,
      };
    }
    return {
      chunk_id: 'fake',
      wall_time_seconds: 0,
      output: '',
      exit_code: 0,
    };
  }
}

test('RemoteProcessManager requires context and rejects environment routing', async () => {
  const workerHub = new FakeWorkerHub();
  const manager = new RemoteProcessManager({
    environmentRegistry: environmentRegistry(),
    workerHub,
    workspaceContextManager: workspaceContextManager(),
  });
  try {
    await assert.rejects(
      manager.execCommand({ cmd: 'echo no-context' }),
      /requires workspace_context/,
    );
    await assert.rejects(
      manager.execCommand({
        workspace_context: CONTEXT_ID,
        environment_id: 'worker-a',
        cmd: 'echo ambiguous',
      }),
      /does not accept environment_id/,
    );
    assert.equal(workerHub.calls.length, 0);
  } finally {
    await manager.close();
  }
});

test('send_file uses context to select Worker without imposing workspace read boundary', async () => {
  const workerHub = new FakeWorkerHub();
  const fileService = new RemoteFileService({
    environmentRegistry: environmentRegistry(),
    workerHub,
    workspaceContextManager: workspaceContextManager(),
  });
  const outsidePath = 'D:\\archive\\outside.pdf';
  const result = await fileService.sendFile({
    workspace_context: CONTEXT_ID,
    path: outsidePath,
  });

  assert.equal(result.environment_id, 'worker-a');
  assert.equal(result.workspace_context, CONTEXT_ID);
  assert.equal(workerHub.calls.length, 1);
  assert.deepEqual(workerHub.calls[0], {
    environmentId: 'worker-a',
    method: 'send_file',
    params: {
      path: outsidePath,
      environment_id: 'worker-a',
      workspace_id: 'projectless-test',
      expected_workspace_root: 'C:\\Users\\test\\Documents\\CCM\\projectless-test',
    },
  });

  await assert.rejects(
    fileService.sendFile({ path: outsidePath }),
    /requires workspace_context/,
  );
});

test('receive_file uses context to select Worker and forwards only a relative destination', async () => {
  const workerHub = new FakeWorkerHub();
  const fileService = new RemoteFileService({
    environmentRegistry: environmentRegistry(),
    workerHub,
    workspaceContextManager: workspaceContextManager(),
  });
  const file = {
    download_url: 'https://files.example.test/download',
    file_id: 'file_route',
    file_name: 'route.txt',
  };
  const result = await fileService.receiveFile({
    workspace_context: CONTEXT_ID,
    file,
    destination: 'nested\\route.txt',
  });

  assert.equal(result.environment_id, 'worker-a');
  assert.equal(result.workspace_context, CONTEXT_ID);
  assert.deepEqual(workerHub.calls[0], {
    environmentId: 'worker-a',
    method: 'receive_file',
    params: {
      file,
      destination: 'nested\\route.txt',
      overwrite: false,
      environment_id: 'worker-a',
      workspace_id: 'projectless-test',
      expected_workspace_root: 'C:\\Users\\test\\Documents\\CCM\\projectless-test',
    },
  });

  await assert.rejects(
    fileService.receiveFile({ file }),
    /requires workspace_context/,
  );
});

test('NativeFileService resolves relative send_file paths from workspace root', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-send-file-context-'));
  try {
    const bootstrapRoot = path.join(tempRoot, 'bootstrap');
    const workspaceRoot = path.join(tempRoot, 'workspace');
    const outsideRoot = path.join(tempRoot, 'outside');
    await Promise.all([
      fs.mkdir(bootstrapRoot, { recursive: true }),
      fs.mkdir(workspaceRoot, { recursive: true }),
      fs.mkdir(outsideRoot, { recursive: true }),
    ]);
    await fs.writeFile(path.join(bootstrapRoot, 'sample.txt'), 'bootstrap');
    await fs.writeFile(path.join(workspaceRoot, 'sample.txt'), 'workspace');
    const outsidePath = path.join(outsideRoot, 'outside.txt');
    await fs.writeFile(outsidePath, 'outside');

    const baseEnvironment = {
      id: 'worker-a',
      cwd: bootstrapRoot,
    };
    const service = new NativeFileService({
      environmentRegistry: {
        resolve: () => baseEnvironment,
      },
      workspaceRegistry: {
        environmentFor(workspaceId, expectedRoot) {
          assert.equal(workspaceId, 'project');
          assert.equal(expectedRoot, workspaceRoot);
          return { ...baseEnvironment, cwd: workspaceRoot };
        },
      },
    });

    const relative = await service.sendFile({
      environment_id: 'worker-a',
      workspace_id: 'project',
      expected_workspace_root: workspaceRoot,
      path: 'sample.txt',
    });
    assert.equal(Buffer.from(relative.data, 'base64').toString('utf8'), 'workspace');
    assert.equal(relative.path, path.join(workspaceRoot, 'sample.txt'));

    const absolute = await service.sendFile({
      environment_id: 'worker-a',
      workspace_id: 'project',
      expected_workspace_root: workspaceRoot,
      path: outsidePath,
    });
    assert.equal(Buffer.from(absolute.data, 'base64').toString('utf8'), 'outside');
    assert.equal(absolute.path, outsidePath);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
