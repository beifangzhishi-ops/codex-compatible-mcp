import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createControllerRuntime } from '../src/controller/runtime.mjs';
import { createWorkerRuntime } from '../src/runtime/index.mjs';
import {
  WorkspaceRegistry,
  resolveWorkspaceRelativePath,
} from '../src/runtime/workspace-registry.mjs';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';
import { RemoteWorkerClient } from '../src/worker/remote-worker-client.mjs';
import { createToolRegistry } from '../src/tools/index.mjs';

test('WorkspaceRegistry keeps registered and projectless workspaces separate', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-workspaces-'));
  const legacyRoot = path.join(tempRoot, 'legacy-project');
  const extraRoot = path.join(tempRoot, 'extra-project');
  const projectlessRoot = path.join(tempRoot, 'Documents', 'CCM');
  await fs.mkdir(legacyRoot, { recursive: true });
  await fs.mkdir(extraRoot, { recursive: true });

  const environments = new EnvironmentRegistry({ resolvePaths: false });
  environments.register({
    id: 'workspace-registry-test',
    platform: 'windows',
    cwd: legacyRoot,
    workspaceRoots: [legacyRoot],
    permissionProfile: 'full-access',
  });
  const registry = new WorkspaceRegistry({
    environmentRegistry: environments,
    stateFile: path.join(tempRoot, 'state', 'workspaces.json'),
    projectlessRoot,
  });

  try {
    const seeded = registry.list();
    assert.equal(seeded.length, 1);
    assert.equal(seeded[0].root, await fs.realpath(legacyRoot));

    const added = registry.register({
      workspace_id: 'extra',
      path: extraRoot,
    });
    assert.equal(added.workspace_id, 'extra');
    assert.equal(registry.list().length, 2);

    const projectless = registry.createProjectless();
    assert.equal(projectless.kind, 'projectless');
    assert.equal(projectless.root.startsWith(projectlessRoot), true);
    assert.equal(registry.list().length, 2, 'projectless is not registered');

    assert.throws(
      () => resolveWorkspaceRelativePath(legacyRoot, '..', 'workdir'),
      /escapes the selected workspace/,
    );
    assert.throws(
      () => resolveWorkspaceRelativePath(legacyRoot, extraRoot, 'workdir'),
      /must be relative/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('WorkspaceRegistry accepts a UTF-8 BOM in persisted state', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-workspace-bom-'));
  const projectRoot = path.join(tempRoot, 'project');
  const stateFile = path.join(tempRoot, 'state', 'workspaces.json');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(
    stateFile,
    '\uFEFF' + JSON.stringify({
      version: 1,
      workspaces: [{
        id: 'bom-project',
        root: projectRoot,
        created_at: '2026-09-22T00:00:00.000Z',
      }],
    }),
    'utf8',
  );

  const environments = new EnvironmentRegistry({ resolvePaths: false });
  environments.register({
    id: 'bom-worker',
    platform: 'windows',
    cwd: projectRoot,
    workspaceRoots: [projectRoot],
    permissionProfile: 'workspace-write',
  });

  try {
    const registry = new WorkspaceRegistry({
      environmentRegistry: environments,
      stateFile,
      seedLegacyWorkspace: false,
    });
    assert.equal(registry.resolve('bom-project').root, await fs.realpath(projectRoot));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('Controller uses projectless contexts and requires approval for registered workspaces', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-contexts-'));
  const legacyRoot = path.join(tempRoot, 'existing-project');
  const newRoot = path.join(tempRoot, 'new-project');
  const projectlessRoot = path.join(tempRoot, 'projectless');
  await fs.mkdir(legacyRoot, { recursive: true });
  await fs.mkdir(newRoot, { recursive: true });

  const controller = createControllerRuntime({ workerPort: 0 });
  const worker = createWorkerRuntime({
    environment: {
      id: 'workspace-worker',
      cwd: legacyRoot,
      permissionProfile: 'full-access',
    },
    workspaceStateFile: path.join(tempRoot, 'state', 'workspaces.json'),
    projectlessRoot,
  });
  let client = null;
  let codeModeManager = null;

  await controller.start();
  try {
    client = new RemoteWorkerClient({
      runtime: worker,
      workerId: 'workspace-worker',
      port: controller.workerHub.address.port,
    });
    await client.connect();
    assert.equal(
      await controller.workerHub.waitForEnvironment('workspace-worker'),
      true,
    );

    const first = await controller.processManager.execCommand({
      cmd: 'Write-Output PROJECTLESS_OK',
    });
    assert.match(first.output, /PROJECTLESS_OK/);
    assert.equal(first.workspace_kind, 'projectless');
    assert.equal(typeof first.workspace_context, 'string');
    assert.equal(first.workspace_root.startsWith(projectlessRoot), true);

    const second = await controller.processManager.execCommand({
      workspace_context: first.workspace_context,
      cmd: 'Write-Output SAME_CONTEXT',
    });
    assert.equal(second.workspace_context, first.workspace_context);
    assert.equal(second.workspace_root, first.workspace_root);

    await assert.rejects(
      controller.processManager.execCommand({
        workspace_context: first.workspace_context,
        workdir: '..',
        cmd: 'Write-Output SHOULD_NOT_RUN',
      }),
      /escapes the selected workspace/,
    );

    const tools = createToolRegistry(controller);
    codeModeManager = tools.codeModeManager;
    const applyPatch = tools.registry.get('apply_patch');
    const legacyPreamblePatch = [
      '*** Begin Patch',
      '*** Environment ID: workspace-worker',
      '*** Add File: isolated.txt',
      '+projectless only',
      '*** End Patch',
    ].join('\n');
    const isolated = await applyPatch.handler({ patch: legacyPreamblePatch });
    assert.equal(isolated.structuredContent.workspace_kind, 'projectless');
    await assert.rejects(
      fs.readFile(path.join(legacyRoot, 'isolated.txt'), 'utf8'),
      /ENOENT/,
    );
    assert.equal(
      await fs.readFile(
        path.join(isolated.structuredContent.workspace_root, 'isolated.txt'),
        'utf8',
      ),
      'projectless only\n',
    );

    const seeded = worker.workspaceRegistry.list()[0];
    const select = tools.registry.get('select_workspace');
    const pending = await select.handler({
      environment_id: 'workspace-worker',
      workspace_id: seeded.workspace_id,
    });
    assert.equal(pending.structuredContent.approval_required, true);
    assert.equal(pending.structuredContent.operation, 'select_workspace');

    controller.approvalManager.respond(
      pending.structuredContent.approval_id,
      'approve',
    );
    const selected = await select.handler({
      environment_id: 'workspace-worker',
      workspace_id: seeded.workspace_id,
      approval_id: pending.structuredContent.approval_id,
    });
    assert.equal(selected.structuredContent.workspace_kind, 'registered');
    assert.equal(selected.structuredContent.workspace_root, await fs.realpath(legacyRoot));

    const register = tools.registry.get('register_workspace');
    const registerPending = await register.handler({
      environment_id: 'workspace-worker',
      workspace_id: 'new-project',
      path: newRoot,
    });
    assert.equal(registerPending.structuredContent.approval_required, true);
    controller.approvalManager.respond(
      registerPending.structuredContent.approval_id,
      'approve',
    );
    const registered = await register.handler({
      environment_id: 'workspace-worker',
      workspace_id: 'new-project',
      path: newRoot,
      approval_id: registerPending.structuredContent.approval_id,
    });
    assert.equal(registered.structuredContent.workspace_id, 'new-project');
    assert.equal(worker.workspaceRegistry.list().length, 2);

    const oldContext = selected.structuredContent.workspace_context;
    await client.close();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        controller.workspaceContextManager.resolve(oldContext);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.throws(
      () => controller.workspaceContextManager.resolve(oldContext),
      /Unknown or expired workspace_context/,
    );
  } finally {
    codeModeManager?.close();
    await client?.close().catch(() => {});
    worker.close();
    await controller.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
