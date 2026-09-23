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
import { WorkspaceContextManager } from '../src/controller/workspace-context-manager.mjs';

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

    const reloaded = new WorkspaceRegistry({
      environmentRegistry: environments,
      stateFile: path.join(tempRoot, 'state', 'workspaces.json'),
      projectlessRoot,
      seedLegacyWorkspace: false,
    });
    assert.deepEqual(reloaded.resolve(projectless.workspace_id), projectless);
    assert.throws(
      () => reloaded.environmentFor('extra', legacyRoot),
      /Workspace root changed/,
    );

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

test('WorkspaceRegistry creates a missing approved project directory only when requested', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-workspace-create-'));
  const legacyRoot = path.join(tempRoot, 'legacy-project');
  const missingRoot = path.join(tempRoot, 'new-project', 'nested');
  await fs.mkdir(legacyRoot, { recursive: true });

  const environments = new EnvironmentRegistry({ resolvePaths: false });
  environments.register({
    id: 'workspace-create-test',
    platform: 'windows',
    cwd: legacyRoot,
    workspaceRoots: [legacyRoot],
    permissionProfile: 'full-access',
  });
  const registry = new WorkspaceRegistry({
    environmentRegistry: environments,
    stateFile: path.join(tempRoot, 'state', 'workspaces.json'),
    seedLegacyWorkspace: false,
  });

  try {
    assert.throws(
      () => registry.inspectPath(missingRoot, 'new-project'),
      /does not exist/,
    );
    const inspected = registry.inspectPath(missingRoot, 'new-project', {
      createIfMissing: true,
    });
    assert.equal(inspected.create_required, true);
    await assert.rejects(fs.stat(missingRoot), /ENOENT/);

    assert.throws(
      () => registry.register({
        workspace_id: 'new-project',
        path: inspected.root,
        create_if_missing: true,
        approved_root: path.join(tempRoot, 'different-approved-root'),
      }),
      /approved target/,
    );
    await assert.rejects(fs.stat(missingRoot), /ENOENT/);

    const registered = registry.register({
      workspace_id: 'new-project',
      path: inspected.root,
      create_if_missing: true,
      approved_root: inspected.root,
    });
    assert.equal((await fs.stat(missingRoot)).isDirectory(), true);
    assert.equal(registered.root, await fs.realpath(missingRoot));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('WorkspaceContextManager persists contexts across controller instances', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-context-state-'));
  const stateFile = path.join(tempRoot, 'workspace-contexts.json');
  const environments = new EnvironmentRegistry({ resolvePaths: false });
  environments.register({
    id: 'context-worker',
    platform: 'windows',
    cwd: tempRoot,
    workspaceRoots: [tempRoot],
    permissionProfile: 'workspace-write',
  });

  try {
    const first = new WorkspaceContextManager({
      environmentRegistry: environments,
      workerHub: {},
      stateFile,
    });
    const created = first.createRegistered('context-worker', {
      workspace_id: 'project-a',
      kind: 'registered',
      root: tempRoot,
    });
    first.close();

    const second = new WorkspaceContextManager({
      environmentRegistry: environments,
      workerHub: {},
      stateFile,
    });
    assert.deepEqual(second.resolve(created.workspace_context), created);
    second.close();
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

  const controller = createControllerRuntime({ workerPort: 0 });
  const workspaceStateFile = path.join(tempRoot, 'state', 'workspaces.json');
  let worker = createWorkerRuntime({
    environment: {
      id: 'workspace-worker',
      cwd: legacyRoot,
      permissionProfile: 'full-access',
    },
    workspaceStateFile,
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

    const projectless = await controller.workspaceContextManager.createProjectless(
      'workspace-worker',
    );
    const first = await controller.processManager.execCommand({
      workspace_context: projectless.workspace_context,
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
    const isolated = await applyPatch.handler({
      workspace_context: first.workspace_context,
      patch: legacyPreamblePatch,
    });
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
    assert.doesNotMatch(pending.structuredContent.justification, /read access/i);

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
      create_if_missing: true,
    });
    assert.equal(registerPending.structuredContent.approval_required, true);
    assert.equal(registerPending.structuredContent.create_if_missing, true);
    assert.match(registerPending.structuredContent.justification, /create, register, and enter/i);
    await assert.rejects(fs.stat(newRoot), /ENOENT/);
    controller.approvalManager.respond(
      registerPending.structuredContent.approval_id,
      'approve',
    );
    const mismatchedRegistration = await register.handler({
      environment_id: 'workspace-worker',
      workspace_id: 'new-project',
      path: newRoot,
      create_if_missing: false,
      approval_id: registerPending.structuredContent.approval_id,
    });
    assert.equal(mismatchedRegistration.isError, true);
    assert.match(mismatchedRegistration.content[0].text, /does not exist|does not match/i);
    await assert.rejects(fs.stat(newRoot), /ENOENT/);

    const registered = await register.handler({
      environment_id: 'workspace-worker',
      workspace_id: 'new-project',
      path: newRoot,
      create_if_missing: true,
      approval_id: registerPending.structuredContent.approval_id,
    });
    assert.equal(registered.structuredContent.workspace_id, 'new-project');
    assert.equal(registered.structuredContent.workspace_kind, 'registered');
    assert.equal(
      registered.structuredContent.workspace_root,
      await fs.realpath(newRoot),
    );
    assert.equal((await fs.stat(newRoot)).isDirectory(), true);
    assert.equal(worker.workspaceRegistry.list().length, 2);

    const oldContext = selected.structuredContent.workspace_context;
    const oldProjectlessContext = first.workspace_context;
    await client.close();
    assert.equal(
      controller.workspaceContextManager.resolve(oldContext).workspace_context,
      oldContext,
    );

    worker.close();
    worker = createWorkerRuntime({
      environment: {
        id: 'workspace-worker',
        cwd: legacyRoot,
        permissionProfile: 'full-access',
      },
      workspaceStateFile,
      projectlessRoot,
    });

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
    const resumed = await controller.processManager.execCommand({
      workspace_context: oldContext,
      cmd: 'Write-Output RESUMED_CONTEXT',
    });
    assert.match(resumed.output, /RESUMED_CONTEXT/);
    assert.equal(resumed.workspace_context, oldContext);

    const resumedProjectless = await controller.processManager.execCommand({
      workspace_context: oldProjectlessContext,
      cmd: 'Write-Output RESUMED_PROJECTLESS',
    });
    assert.match(resumedProjectless.output, /RESUMED_PROJECTLESS/);
    assert.equal(resumedProjectless.workspace_context, oldProjectlessContext);
    assert.equal(resumedProjectless.workspace_root, first.workspace_root);
  } finally {
    codeModeManager?.close();
    await client?.close().catch(() => {});
    worker.close();
    await controller.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
