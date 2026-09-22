import { parsePatch } from './apply-patch.mjs';

export class RemoteFileService {
  constructor({ environmentRegistry, workerHub, workspaceContextManager = null }) {
    if (!environmentRegistry || !workerHub) {
      throw new Error('RemoteFileService requires environmentRegistry and workerHub.');
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.workspaceContextManager = workspaceContextManager;
  }

  async #resolveExecution(args, fallbackEnvironmentId = null) {
    const contextMode = args.workspace_scoped === true ||
      Boolean(args.workspace_context) ||
      (!args.environment_id && !fallbackEnvironmentId);
    if (!contextMode) {
      const environment = this.environmentRegistry.resolve(
        args.environment_id || fallbackEnvironmentId,
      );
      return { environment, workspaceContext: null, workspaceId: null };
    }
    if (!this.workspaceContextManager) {
      throw new Error('Workspace context manager is not available.');
    }
    const workspaceContext = args.workspace_context
      ? this.workspaceContextManager.resolve(args.workspace_context)
      : await this.workspaceContextManager.createProjectless();
    const environment = this.environmentRegistry.resolve(
      workspaceContext.environment_id,
    );
    return {
      environment,
      workspaceContext,
      workspaceId: workspaceContext.workspace_id,
    };
  }

  async applyPatch(args) {
    const parsed = parsePatch(args.patch);
    const execution = await this.#resolveExecution(args, parsed.environmentId);
    if (execution.workspaceContext &&
        parsed.environmentId &&
        parsed.environmentId !== execution.environment.id) {
      throw new Error(
        'apply_patch environment mismatch: context=' +
        execution.environment.id + ', patch=' + parsed.environmentId,
      );
    }
    if (!execution.workspaceContext && args.environment_id &&
        parsed.environmentId &&
        args.environment_id !== parsed.environmentId) {
      throw new Error(
        'apply_patch environment mismatch: argument=' + args.environment_id +
        ', patch=' + parsed.environmentId,
      );
    }

    const environment = execution.workspaceContext
      ? execution.environment
      : this.environmentRegistry.resolve(
          args.environment_id || parsed.environmentId,
        );
    if (!environment.capabilities?.applyPatch) {
      throw new Error(
        'Environment does not support apply_patch: ' + environment.id,
      );
    }

    const forwarded = {
      ...args,
      environment_id: environment.id,
      ...(execution.workspaceId
        ? {
            workspace_id: execution.workspaceId,
            expected_workspace_root: execution.workspaceContext.workspace_root,
          }
        : {}),
    };
    delete forwarded.workspace_context;
    delete forwarded.workspace_scoped;
    const result = await this.workerHub.call(
      environment.id,
      'apply_patch',
      forwarded,
      { timeoutMs: 30_000 },
    );
    return { ...result, ...(execution.workspaceContext || {}) };
  }
  async viewImage(args) {
    const execution = await this.#resolveExecution(args);
    const environment = execution.environment;
    if (!environment.capabilities?.viewImage) {
      throw new Error(
        'Environment does not support view_image: ' + environment.id,
      );
    }

    const forwarded = {
      ...args,
      environment_id: environment.id,
      ...(execution.workspaceId
        ? {
            workspace_id: execution.workspaceId,
            expected_workspace_root: execution.workspaceContext.workspace_root,
          }
        : {}),
    };
    delete forwarded.workspace_context;
    const result = await this.workerHub.call(
      environment.id,
      'view_image',
      forwarded,
      { timeoutMs: 30_000 },
    );
    return { ...result, ...(execution.workspaceContext || {}) };
  }

  async sendFile(args) {
    const environment = this.environmentRegistry.resolve(args.environment_id);
    if (!environment.capabilities?.sendFile) {
      throw new Error(
        'Environment does not support send_file: ' + environment.id,
      );
    }

    return this.workerHub.call(
      environment.id,
      'send_file',
      { ...args, environment_id: environment.id },
      { timeoutMs: 60_000 },
    );
  }
}
