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
import { WorkspaceHandleManager } from '../src/controller/workspace-handle-manager.mjs';

test('WorkspaceRegistry keeps registered and projectless workspaces separate', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-workspaces-'));
  const bootstrapRoot = path.join(tempRoot, 'bootstrap-project');
  const extraRoot = path.join(tempRoot, 'extra-project');
  const projectlessRoot = path.join(tempRoot, 'Documents', 'CCM');
  await fs.mkdir(bootstrapRoot, { recursive: true });
  await fs.mkdir(extraRoot, { recursive: true });

  const environments = new EnvironmentRegistry({ resolvePaths: false });
  environments.register({
    id: 'workspace-registry-test',
    platform: 'windows',
    cwd: bootstrapRoot,
    workspaceRoots: [bootstrapRoot],
    permissionProfile: 'full-access',
  });
  const registry = new WorkspaceRegistry({
    environmentRegistry: environments,
    stateFile: path.join(tempRoot, 'state', 'workspaces.json'),
    projectlessRoot,
  });

  try {
    const seeded = registry.listRegistered();
    assert.equal(seeded.length, 1);
    assert.equal(seeded[0].root, await fs.realpath(bootstrapRoot));

    const added = registry.register({
      workspace_id: 'extra',
      path: extraRoot,
    });
    assert.equal(added.workspace_id, 'extra');
    assert.equal(registry.listRegistered().length, 2);

    const projectless = registry.createProjectless();
    assert.equal(projectless.kind, 'projectless');
    assert.equal(projectless.root.startsWith(projectlessRoot), true);
    assert.equal(registry.listRegistered().length, 2, 'projectless is not registered');
    assert.equal(registry.listProjectless().length, 1);

    const reloaded = new WorkspaceRegistry({
      environmentRegistry: environments,
      stateFile: path.join(tempRoot, 'state', 'workspaces.json'),
      projectlessRoot,
      seedBootstrapWorkspace: false,
    });
    assert.deepEqual(reloaded.resolve(projectless.workspace_id), projectless);
    assert.throws(
      () => reloaded.environmentFor('extra', bootstrapRoot),
      /Workspace root changed/,
    );

    assert.throws(
      () => resolveWorkspaceRelativePath(bootstrapRoot, '..', 'workdir'),
      /escapes the selected workspace/,
    );
    assert.throws(
      () => resolveWorkspaceRelativePath(bootstrapRoot, extraRoot, 'workdir'),
      /must be relative/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('WorkspaceRegistry creates a missing approved project directory only when requested', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-workspace-create-'));
  const bootstrapRoot = path.join(tempRoot, 'bootstrap-project');
  const missingRoot = path.join(tempRoot, 'new-project', 'nested');
  await fs.mkdir(bootstrapRoot, { recursive: true });

  const environments = new EnvironmentRegistry({ resolvePaths: false });
  environments.register({
    id: 'workspace-create-test',
    platform: 'windows',
    cwd: bootstrapRoot,
    workspaceRoots: [bootstrapRoot],
    permissionProfile: 'full-access',
  });
  const registry = new WorkspaceRegistry({
    environmentRegistry: environments,
    stateFile: path.join(tempRoot, 'state', 'workspaces.json'),
    seedBootstrapWorkspace: false,
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

test('WorkspaceRegistry unregisters only the frozen registration and never deletes files or re-seeds it', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-unregister-'));
  const project = path.join(tempRoot, 'project');
  const stateFile = path.join(tempRoot, 'state.json');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'keep.txt'), 'keep');
  const environmentRegistry = new EnvironmentRegistry({ resolvePaths: false });
  environmentRegistry.register({ id: 'worker', cwd: project, permissionProfile: 'full-access' });
  try {
    const registry = new WorkspaceRegistry({ environmentRegistry, stateFile });
    const [workspace] = registry.listRegistered();
    assert.equal(workspace.root, await fs.realpath(project));
    assert.throws(() => registry.unregister({
      workspace_id: workspace.workspace_id,
      expected_root: project,
      expected_created_at: 'incorrect',
    }), /no longer matches/);
    assert.equal(registry.listRegistered().length, 1);
    assert.deepEqual(registry.unregister({
      workspace_id: workspace.workspace_id,
      expected_root: workspace.root,
      expected_created_at: workspace.created_at,
    }), workspace);
    assert.equal(registry.listRegistered().length, 0);
    assert.equal(await fs.readFile(path.join(project, 'keep.txt'), 'utf8'), 'keep');
    assert.throws(() => registry.resolve(workspace.workspace_id), /Unknown workspace_id/);
    assert.throws(() => registry.unregister({
      workspace_id: workspace.workspace_id,
      expected_root: workspace.root,
      expected_created_at: workspace.created_at,
    }), /Unknown registered workspace_id/);

    const reloaded = new WorkspaceRegistry({ environmentRegistry, stateFile });
    assert.deepEqual(reloaded.listRegistered(), [], 'removed bootstrap is not restored');
    assert.equal(await fs.readFile(path.join(project, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('WorkspaceRegistry can inspect and unregister a registration whose directory was deleted', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-unregister-missing-'));
  const bootstrap = path.join(tempRoot, 'bootstrap');
  const missing = path.join(tempRoot, 'missing');
  await fs.mkdir(bootstrap);
  await fs.mkdir(missing);
  const environmentRegistry = new EnvironmentRegistry({ resolvePaths: false });
  environmentRegistry.register({ id: 'worker', cwd: bootstrap, permissionProfile: 'full-access' });
  try {
    const stateFile = path.join(tempRoot, 'state.json');
    const registry = new WorkspaceRegistry({ environmentRegistry, stateFile });
    const registered = registry.register({ workspace_id: 'gone', path: missing });
    await fs.rm(missing, { recursive: true });
    assert.throws(() => registry.resolve('gone'), /directory no longer exists/);
    assert.deepEqual(registry.getRegistered('gone'), registered);
    assert.deepEqual(registry.unregister({
      workspace_id: 'gone',
      expected_root: registered.root,
      expected_created_at: registered.created_at,
    }), registered);
    assert.throws(() => registry.getRegistered('gone'), /Unknown registered workspace_id/);
    const reloaded = new WorkspaceRegistry({ environmentRegistry, stateFile });
    assert.equal(reloaded.listRegistered().some((workspace) => workspace.workspace_id === 'gone'), false);
    await assert.rejects(fs.stat(missing), /ENOENT/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('WorkspaceHandleManager persists handles across controller instances', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-context-state-'));
  const stateFile = path.join(tempRoot, 'workspace-handles.json');
  const environments = new EnvironmentRegistry({ resolvePaths: false });
  environments.register({
    id: 'context-worker',
    platform: 'windows',
    cwd: tempRoot,
    workspaceRoots: [tempRoot],
    permissionProfile: 'workspace-write',
  });

  try {
    const first = new WorkspaceHandleManager({
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

    const second = new WorkspaceHandleManager({
      environmentRegistry: environments,
      workerHub: {},
      stateFile,
    });
    assert.deepEqual(second.resolve(created.workspace_handle), created);
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
      seedBootstrapWorkspace: false,
    });
    assert.equal(registry.resolve('bom-project').root, await fs.realpath(projectRoot));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('full-access Controller enters registered workspaces without approval', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-handles-'));
  const bootstrapRoot = path.join(tempRoot, 'existing-project');
  const newRoot = path.join(tempRoot, 'new-project');
  const projectlessRoot = path.join(tempRoot, 'projectless');
  await fs.mkdir(bootstrapRoot, { recursive: true });

  const controller = createControllerRuntime({
    workerPort: 0,
    auditLogFile: path.join(tempRoot, 'audit.jsonl'),
    execPolicyStateFile: path.join(tempRoot, 'exec-policy.json'),
    trustedPackageScriptStateFile: path.join(tempRoot, 'trusted-package-scripts.json'),
    workspaceHandleStateFile: path.join(tempRoot, 'workspace-handles.json'),
    fileTransferStateDir: path.join(tempRoot, 'file-transfers'),
    planStateDir: path.join(tempRoot, 'plans'),
  });
  const workspaceStateFile = path.join(tempRoot, 'state', 'workspaces.json');
  let worker = createWorkerRuntime({
    environment: {
      id: 'workspace-worker',
      cwd: bootstrapRoot,
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

    const projectless = await controller.workspaceHandleManager.createProjectless(
      'workspace-worker',
    );
    const first = await controller.processManager.execCommand({
      workspace_handle: projectless.workspace_handle,
      cmd: 'Write-Output PROJECTLESS_OK',
    });
    assert.match(first.output, /PROJECTLESS_OK/);
    assert.equal(first.workspace_kind, 'projectless');
    assert.equal(typeof first.workspace_handle, 'string');
    assert.equal(first.workspace_root.startsWith(projectlessRoot), true);

    const second = await controller.processManager.execCommand({
      workspace_handle: first.workspace_handle,
      cmd: 'Write-Output SAME_CONTEXT',
    });
    assert.equal(second.workspace_handle, first.workspace_handle);
    assert.equal(second.workspace_root, first.workspace_root);

    await assert.rejects(
      controller.processManager.execCommand({
        workspace_handle: first.workspace_handle,
        workdir: '..',
        cmd: 'Write-Output SHOULD_NOT_RUN',
      }),
      /escapes the selected workspace/,
    );

    const tools = createToolRegistry(controller);
    codeModeManager = tools.codeModeManager;
    const elevated = await tools.registry.get('exec_command').handler({
      workspace_handle: first.workspace_handle,
      cmd: 'Write-Output FULL_ACCESS_ESCALATED',
      sandbox_permissions: 'require_escalated',
    });
    assert.match(elevated.structuredContent.output, /FULL_ACCESS_ESCALATED/);
    assert.equal(
      Object.hasOwn(elevated.structuredContent, 'approval_required'),
      false,
    );
    assert.equal(Object.hasOwn(elevated.structuredContent, 'approval_id'), false);

    const applyPatch = tools.registry.get('apply_patch');
    const isolatedPatch = [
      '*** Begin Patch',
      '*** Add File: isolated.txt',
      '+projectless only',
      '*** End Patch',
    ].join('\n');
    const isolated = await applyPatch.handler({
      workspace_handle: first.workspace_handle,
      patch: isolatedPatch,
    });
    assert.equal(isolated.structuredContent.workspace_kind, 'projectless');
    await assert.rejects(
      fs.readFile(path.join(bootstrapRoot, 'isolated.txt'), 'utf8'),
      /ENOENT/,
    );
    assert.equal(
      await fs.readFile(
        path.join(isolated.structuredContent.workspace_root, 'isolated.txt'),
        'utf8',
      ),
      'projectless only\n',
    );

    const seeded = worker.workspaceRegistry.listRegistered()[0];
    const select = tools.registry.get('select_workspace');
    const selected = await select.handler({
      environment_id: 'workspace-worker',
      workspace_id: seeded.workspace_id,
    }, { extra: { _meta: { 'openai/session': 'workspace-test' } } });
    assert.equal(
      Object.hasOwn(selected.structuredContent, 'approval_required'),
      false,
    );
    assert.equal(Object.hasOwn(selected.structuredContent, 'approval_id'), false);
    assert.equal(selected.structuredContent.workspace_kind, 'registered');
    assert.equal(selected.structuredContent.workspace_root, await fs.realpath(bootstrapRoot));

    const register = tools.registry.get('register_workspace');
    const registered = await register.handler({
      environment_id: 'workspace-worker',
      workspace_id: 'new-project',
      path: newRoot,
      create_if_missing: true,
    }, { extra: { _meta: { 'openai/session': 'workspace-test' } } });
    assert.equal(
      Object.hasOwn(registered.structuredContent, 'approval_required'),
      false,
    );
    assert.equal(Object.hasOwn(registered.structuredContent, 'approval_id'), false);
    assert.equal(registered.structuredContent.workspace_id, 'new-project');
    assert.equal(registered.structuredContent.workspace_kind, 'registered');
    assert.equal(
      registered.structuredContent.workspace_root,
      await fs.realpath(newRoot),
    );
    assert.equal((await fs.stat(newRoot)).isDirectory(), true);
    assert.equal(worker.workspaceRegistry.listRegistered().length, 2);

    const nestedSelect = await tools.registry.get('exec').handler({
      calls: [{
        tool: 'ccm.select_workspace',
        arguments: {
          environment_id: 'workspace-worker',
          workspace_id: seeded.workspace_id,
        },
      }],
      yield_time_ms: 1000,
    });
    const nestedSelected =
      nestedSelect.structuredContent.calls[0].result.structured_content;
    assert.equal(nestedSelected.workspace_kind, 'registered');
    assert.equal(Object.hasOwn(nestedSelected, 'approval_required'), false);
    assert.equal(Object.hasOwn(nestedSelected, 'approval_id'), false);

    const oldContext = selected.structuredContent.workspace_handle;
    const oldProjectlessContext = first.workspace_handle;
    await client.close();
    assert.equal(
      controller.workspaceHandleManager.resolve(oldContext).workspace_handle,
      oldContext,
    );

    worker.close();
    worker = createWorkerRuntime({
      environment: {
        id: 'workspace-worker',
        cwd: bootstrapRoot,
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
      workspace_handle: oldContext,
      cmd: 'Write-Output RESUMED_CONTEXT',
    });
    assert.match(resumed.output, /RESUMED_CONTEXT/);
    assert.equal(resumed.workspace_handle, oldContext);

    const resumedProjectless = await controller.processManager.execCommand({
      workspace_handle: oldProjectlessContext,
      cmd: 'Write-Output RESUMED_PROJECTLESS',
    });
    assert.match(resumedProjectless.output, /RESUMED_PROJECTLESS/);
    assert.equal(resumedProjectless.workspace_handle, oldProjectlessContext);
    assert.equal(resumedProjectless.workspace_root, first.workspace_root);

    const unregisterTool = tools.registry.get('unregister_workspace');
    const resolveCard = tools.registry.get('resolve_pending_action');
    const requestCard = tools.registry.get('request_approval');
    const requested = await unregisterTool.handler({
      environment_id: 'workspace-worker', workspace_id: 'new-project',
    });
    assert.equal(requested.structuredContent.approval_required, true,
      'deregistration needs approval even in full-access');
    assert.equal(requested.structuredContent.operation, 'unregister_workspace');
    assert.equal(worker.workspaceRegistry.listRegistered().length, 2,
      'request alone does not unregister');

    const deniedCard = await requestCard.handler({
      approval_id: requested.structuredContent.approval_id,
    });
    const denied = await resolveCard.handler({
      approval_id: requested.structuredContent.approval_id,
      approval_nonce: deniedCard._meta.approval_nonce,
      decision: 'deny',
    });
    assert.equal(denied.structuredContent.state, 'denied');
    assert.equal(worker.workspaceRegistry.listRegistered().length, 2);

    const stale = await unregisterTool.handler({
      environment_id: 'workspace-worker', workspace_id: 'new-project',
    });
    const staleCard = await requestCard.handler({
      approval_id: stale.structuredContent.approval_id,
    });
    const priorRegistration = worker.workspaceRegistry.resolve('new-project');
    worker.workspaceRegistry.unregister({
      workspace_id: 'new-project',
      expected_root: priorRegistration.root,
      expected_created_at: priorRegistration.created_at,
    });
    const otherRoot = path.join(tempRoot, 'different-project');
    await fs.mkdir(otherRoot);
    worker.workspaceRegistry.register({ workspace_id: 'new-project', path: otherRoot });
    const staleOutcome = await resolveCard.handler({
      approval_id: stale.structuredContent.approval_id,
      approval_nonce: staleCard._meta.approval_nonce,
      decision: 'approve',
    });
    assert.equal(staleOutcome.structuredContent.action_failed, true);
    assert.equal(worker.workspaceRegistry.resolve('new-project').root, await fs.realpath(otherRoot));

    const toRemove = await unregisterTool.handler({
      environment_id: 'workspace-worker', workspace_id: 'new-project',
    });
    const approvalCard = await requestCard.handler({
      approval_id: toRemove.structuredContent.approval_id,
    });
    const removed = await resolveCard.handler({
      approval_id: toRemove.structuredContent.approval_id,
      approval_nonce: approvalCard._meta.approval_nonce,
      decision: 'approve',
    });
    assert.equal(removed.structuredContent.state, 'consumed');
    assert.match(removed.structuredContent.output, /unregistered/);
    assert.equal(worker.workspaceRegistry.listRegistered().length, 1);
    assert.throws(() => controller.workspaceHandleManager.resolve(
      registered.structuredContent.workspace_handle,
    ), /Unknown or expired/);
    await assert.rejects(controller.processManager.execCommand({
      workspace_handle: registered.structuredContent.workspace_handle,
      cmd: 'Write-Output SHOULD_NOT_RUN',
    }), /Unknown or expired workspace_handle/);
    assert.equal((await fs.stat(newRoot)).isDirectory(), true);
    assert.equal((await fs.stat(otherRoot)).isDirectory(), true);

    const persistedContexts = new WorkspaceHandleManager({
      environmentRegistry: controller.environmentRegistry,
      workerHub: controller.workerHub,
      stateFile: path.join(tempRoot, 'workspace-handles.json'),
    });
    assert.throws(() => persistedContexts.resolve(
      registered.structuredContent.workspace_handle,
    ), /Unknown or expired/);

    // A missing directory must not block frozen approval for a Worker-local
    // registration; the normal select/exec path still rejects that directory.
    const goneRoot = path.join(tempRoot, 'gone-project');
    await fs.mkdir(goneRoot);
    const goneRegistration = worker.workspaceRegistry.register({
      workspace_id: 'gone-project', path: goneRoot,
    });
    await fs.rm(goneRoot, { recursive: true });
    assert.deepEqual(await controller.workerHub.call(
      'workspace-worker', 'get_registered_workspace',
      { workspace_id: 'gone-project' },
    ), goneRegistration);
    assert.equal((await unregisterTool.handler({
      environment_id: 'workspace-worker', workspace_id: 'missing-name',
    })).isError, true);
    const goneRequest = await unregisterTool.handler({
      environment_id: 'workspace-worker', workspace_id: 'gone-project',
    });
    assert.equal(goneRequest.structuredContent.approval_required, true);
    assert.equal(worker.workspaceRegistry.listRegistered().some(
      (workspace) => workspace.workspace_id === 'gone-project'), true);
    const goneCard = await requestCard.handler({
      approval_id: goneRequest.structuredContent.approval_id,
    });
    const goneOutcome = await resolveCard.handler({
      approval_id: goneRequest.structuredContent.approval_id,
      approval_nonce: goneCard._meta.approval_nonce,
      decision: 'approve',
    });
    assert.equal(goneOutcome.structuredContent.state, 'consumed');
    assert.equal(worker.workspaceRegistry.listRegistered().some(
      (workspace) => workspace.workspace_id === 'gone-project'), false);
  } finally {
    codeModeManager?.close();
    await client?.close().catch(() => {});
    worker.close();
    await controller.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
