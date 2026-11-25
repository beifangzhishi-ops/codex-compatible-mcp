import { readProjectDirectoryHints } from '../runtime/ccm-config.mjs';

async function executeWorkspaceAction(runtime, action) {
  const environment = runtime.environmentRegistry.resolve(
    action.environment_id,
  );
  let workspace;
  if (action.operation === 'unregister_workspace') {
    const current = await runtime.workerHub.call(
      environment.id,
      'get_registered_workspace',
      { workspace_id: action.workspace_id },
      { timeoutMs: 10_000 },
    );
    if (current.kind !== 'registered' ||
        current.workspace_id !== action.workspace_id ||
        current.root !== action.workspace_root ||
        current.created_at !== action.workspace_created_at) {
      throw new Error('Workspace registration changed before it could be unregistered.');
    }
    // Revoke Controller context handles before changing the Worker registry.
    // A failed Controller state write must not leave an unrevoked old context.
    runtime.workspaceHandleManager.revokeRegistered(
      environment.id, action.workspace_id,
    );
    await runtime.workerHub.call(
      environment.id,
      'unregister_workspace',
      {
        workspace_id: action.workspace_id,
        expected_root: action.workspace_root,
        expected_created_at: action.workspace_created_at,
      },
      { timeoutMs: 10_000 },
    );
    return null;
  }
  if (action.operation === 'select_workspace') {
    if (action.workspace_registered === false) {
      const inspected = await runtime.workerHub.call(
        environment.id,
        'inspect_existing_project',
        { path: action.workspace_root },
        { timeoutMs: 10_000 },
      );
      if (inspected.registered || inspected.workspace_id !== action.workspace_id ||
          inspected.root !== action.workspace_root) {
        throw new Error('Project directory or registration changed since inspection.');
      }
      workspace = await runtime.workerHub.call(
        environment.id,
        'register_workspace',
        {
          path: action.workspace_root,
          workspace_id: action.workspace_id,
          approved_root: action.workspace_root,
          unregistered_only: true,
        },
        { timeoutMs: 10_000 },
      );
    } else {
      workspace = await runtime.workerHub.call(
        environment.id,
        'get_workspace',
        { workspace_id: action.workspace_id },
        { timeoutMs: 10_000 },
      );
      if (workspace.kind !== 'registered' ||
          workspace.workspace_id !== action.workspace_id ||
          workspace.root !== action.workspace_root ||
          workspace.created_at !== action.workspace_created_at) {
        throw new Error('Workspace identity changed since inspection.');
      }
    }
  } else if (action.operation === 'register_workspace') {
    const inspected = await runtime.workerHub.call(
      environment.id,
      'inspect_workspace_path',
      {
        path: action.workspace_root,
        workspace_id: action.workspace_id,
        create_if_missing: true,
      },
      { timeoutMs: 10_000 },
    );
    if (inspected.exists || inspected.workspace_id !== action.workspace_id ||
        inspected.root !== action.workspace_root) {
      throw new Error(
        'Project directory already exists or changed; register the existing directory instead.',
      );
    }
    workspace = await runtime.workerHub.call(
      environment.id,
      'register_workspace',
      {
        path: action.workspace_root,
        workspace_id: action.workspace_id,
        create_if_missing: true,
        approved_root: action.workspace_root,
        new_project_only: true,
      },
      { timeoutMs: 10_000 },
    );
    if (workspace.kind !== 'registered' || workspace.workspace_id !== action.workspace_id ||
        workspace.root !== action.workspace_root) {
      throw new Error(
        'Registered workspace no longer matches the requested target.',
      );
    }
  } else {
    throw new Error('Unknown workspace operation: ' + action.operation);
  }

  return runtime.workspaceHandleManager.createRegistered(environment.id, workspace);
}

export async function listManagedProjects(runtime, args = {}) {
  const directoryHints = readProjectDirectoryHints(runtime.ccmConfigFile);
  const publicEnvironments = runtime.environmentRegistry.listPublic();
  let environments = publicEnvironments;
  if (args.environment_id) {
    runtime.environmentRegistry.resolve(args.environment_id);
    environments = publicEnvironments.filter(
      (environment) => environment.id === args.environment_id,
    );
  }
  const includeAll = Boolean(args.all);
  const discover = async (environment) => {
    const directoryHintList = Object.hasOwn(directoryHints, environment.id)
      ? directoryHints[environment.id] : undefined;
    const withDirectoryHint = (result) => ({
      ...result,
      ...(directoryHintList === undefined ? {} : { project_directory_hints: directoryHintList }),
    });
    const currentStatus = runtime.workerHub.environmentStatus?.(
      environment.id,
    ) || { state: 'normal' };
    if (currentStatus.state === 'abnormal') {
      const error = new Error(
        currentStatus.abnormal_reason ||
        'Remote Worker is quarantined.',
      );
      error.code = 'worker_quarantined';
      if (args.environment_id) throw error;
      return withDirectoryHint({ ...environment, ...currentStatus });
    }

    try {
      const result = await runtime.workerHub.call(
        environment.id,
        'list_projects',
        { all: includeAll },
        { timeoutMs: 10_000 },
      );
      return withDirectoryHint({
        ...environment,
        state: 'normal',
        ...(currentStatus.connected_at ? { connected_at: currentStatus.connected_at } : {}),
        projects: result.projects || [],
        ...(includeAll
          ? { projectless_workspaces: result.projectless_workspaces || [] }
          : {}),
      });
    } catch (error) {
      runtime.workerHub.quarantine?.(
        environment.id,
        error?.code || 'project_discovery_failed',
        String(error?.message || error),
      );
      if (args.environment_id) throw error;
      const failedStatus = runtime.workerHub.environmentStatus?.(
        environment.id,
      ) || {
        state: 'abnormal',
        abnormal_code: error?.code || 'project_discovery_failed',
        abnormal_reason: String(error?.message || error),
      };
      return withDirectoryHint({
        ...environment,
        ...failedStatus,
        project_discovery_error: String(error?.message || error),
      });
    }
  };
  const enriched = await Promise.all(environments.map(discover));
  return { default_environment_id: runtime.environmentRegistry.defaultEnvironmentId, environments: enriched };
}

export async function manageProject(runtime, action, args) {
  const environment = runtime.environmentRegistry.resolve(args.environment_id);
  const call = (method, params) => runtime.workerHub.call(environment.id, method, params, { timeoutMs: 10_000 });
  if (action === 'register') {
    const inspected = await call('inspect_workspace_path', { path: args.path, workspace_id: args.workspace_id, create_if_missing: true });
    if (!inspected.exists) return executeWorkspaceAction(runtime, { operation: 'register_workspace', environment_id: environment.id,
      workspace_id: inspected.workspace_id, workspace_root: inspected.root });
  }
  if (action === 'handle' || action === 'register') {
    const workspace = action === 'register'
      ? await call('inspect_existing_project', { path: args.path })
      : await call('get_workspace', { workspace_id: args.workspace_id });
    if (action === 'handle' && workspace.kind !== 'registered') throw new Error('Not a registered project.');
    if (workspace.registered !== false) {
      const existing = runtime.workspaceHandleManager.findRegistered(environment.id, workspace);
      if (existing) return existing;
    }
    return executeWorkspaceAction(runtime, { operation: 'select_workspace', environment_id: environment.id,
      workspace_id: workspace.workspace_id, workspace_root: workspace.root,
      workspace_registered: workspace.registered !== false, workspace_created_at: workspace.created_at });
  }
  if (action === 'remove') {
    const workspace = await call('get_registered_workspace', { workspace_id: args.workspace_id });
    if (workspace.kind !== 'registered') throw new Error('Not a registered project.');
    await executeWorkspaceAction(runtime, { operation: 'unregister_workspace', environment_id: environment.id,
      workspace_id: workspace.workspace_id, workspace_root: workspace.root, workspace_created_at: workspace.created_at });
    return { unregistered: true, workspace_id: workspace.workspace_id, project_files_deleted: false };
  }
  throw new Error('Unknown project action.');
}
