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

  #resolveExecution(args, fallbackEnvironmentId = null) {
    if (!args.workspace_context) {
      throw new Error('File operation requires workspace_context.');
    }
    if (args.environment_id) {
      throw new Error(
        'File operation does not accept environment_id; workspace_context already determines the environment.',
      );
    }
    if (!this.workspaceContextManager) {
      throw new Error('Workspace context manager is not available.');
    }
    const workspaceContext = this.workspaceContextManager.resolve(
      args.workspace_context,
    );
    const environment = this.environmentRegistry.resolve(
      workspaceContext.environment_id,
    );
    if (fallbackEnvironmentId && fallbackEnvironmentId !== environment.id) {
      throw new Error(
        'File operation environment mismatch: context=' + environment.id +
        ', requested=' + fallbackEnvironmentId,
      );
    }
    return {
      environment,
      workspaceContext,
      workspaceId: workspaceContext.workspace_id,
    };
  }

  async applyPatch(args) {
    const parsed = parsePatch(args.patch);
    const execution = this.#resolveExecution(args, parsed.environmentId);
    const environment = execution.environment;
    if (!environment.capabilities?.applyPatch) {
      throw new Error(
        'Environment does not support apply_patch: ' + environment.id,
      );
    }

    const forwarded = {
      ...args,
      environment_id: environment.id,
      workspace_id: execution.workspaceId,
      expected_workspace_root: execution.workspaceContext.workspace_root,
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
    const execution = this.#resolveExecution(args);
    const environment = execution.environment;
    if (!environment.capabilities?.viewImage) {
      throw new Error(
        'Environment does not support view_image: ' + environment.id,
      );
    }

    const forwarded = {
      ...args,
      environment_id: environment.id,
      workspace_id: execution.workspaceId,
      expected_workspace_root: execution.workspaceContext.workspace_root,
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
    const execution = this.#resolveExecution(args);
    const environment = execution.environment;
    if (!environment.capabilities?.sendFile) {
      throw new Error(
        'Environment does not support send_file: ' + environment.id,
      );
    }

    const result = await this.workerHub.call(
      environment.id,
      'send_file',
      {
        path: args.path,
        environment_id: environment.id,
      },
      { timeoutMs: 60_000 },
    );
    return { ...result, ...execution.workspaceContext };
  }
}
