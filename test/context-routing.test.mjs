import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';
import { RemoteFileService } from '../src/runtime/filesystem/remote-file-service.mjs';

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
    },
  });

  await assert.rejects(
    fileService.sendFile({ path: outsidePath }),
    /requires workspace_context/,
  );
});
