export class RemoteFileService {
  constructor({ environmentRegistry, workerHub, workspaceHandleManager = null }) {
    if (!environmentRegistry || !workerHub) {
      throw new Error('RemoteFileService requires environmentRegistry and workerHub.');
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.workspaceHandleManager = workspaceHandleManager;
  }

  #resolveExecution(args) {
    if (!args.workspace_handle) {
      throw new Error('File operation requires workspace_handle.');
    }
    if (args.environment_id) {
      throw new Error(
        'File operation does not accept environment_id; workspace_handle already determines the environment.',
      );
    }
    if (!this.workspaceHandleManager) {
      throw new Error('Workspace handle manager is not available.');
    }
    const workspaceHandle = this.workspaceHandleManager.resolve(
      args.workspace_handle,
    );
    const environment = this.environmentRegistry.resolve(
      workspaceHandle.environment_id,
    );
    return {
      environment,
      workspaceHandle,
      workspaceId: workspaceHandle.workspace_id,
    };
  }

  async applyPatch(args) {
    const execution = this.#resolveExecution(args);
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
      expected_workspace_root: execution.workspaceHandle.workspace_root,
    };
    delete forwarded.workspace_handle;
    delete forwarded.workspace_scoped;
    const result = await this.workerHub.call(
      environment.id,
      'apply_patch',
      forwarded,
      { timeoutMs: 30_000 },
    );
    return { ...result, ...(execution.workspaceHandle || {}) };
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
      expected_workspace_root: execution.workspaceHandle.workspace_root,
    };
    delete forwarded.workspace_handle;
    const result = await this.workerHub.call(
      environment.id,
      'view_image',
      forwarded,
      { timeoutMs: 30_000 },
    );
    return { ...result, ...(execution.workspaceHandle || {}) };
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
        workspace_id: execution.workspaceId,
        expected_workspace_root: execution.workspaceHandle.workspace_root,
      },
      { timeoutMs: 60_000 },
    );
    return { ...result, ...execution.workspaceHandle };
  }

  async receiveFile(args) {
    const execution = this.#resolveExecution(args);
    const environment = execution.environment;
    if (!environment.capabilities?.receiveFile) {
      throw new Error(
        'Environment does not support receive_file: ' + environment.id,
      );
    }

    const result = await this.workerHub.call(
      environment.id,
      'receive_file',
      {
        file: args.file,
        destination: args.destination,
        overwrite: args.overwrite === true,
        environment_id: environment.id,
        workspace_id: execution.workspaceId,
        expected_workspace_root: execution.workspaceHandle.workspace_root,
      },
      { timeoutMs: 330_000 },
    );
    return { ...result, ...execution.workspaceHandle };
  }
}
