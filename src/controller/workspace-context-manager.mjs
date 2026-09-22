import crypto from 'node:crypto';

function publicContext(record) {
  return {
    workspace_context: record.id,
    environment_id: record.environmentId,
    workspace_id: record.workspaceId,
    workspace_kind: record.kind,
    workspace_root: record.root,
    created_at: record.createdAt,
  };
}

export class WorkspaceContextManager {
  constructor({ environmentRegistry, workerHub } = {}) {
    if (!environmentRegistry || !workerHub) {
      throw new Error(
        'WorkspaceContextManager requires environmentRegistry and workerHub.',
      );
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.contexts = new Map();
    this.onEnvironmentDisconnected = (environmentId) => {
      for (const [id, context] of this.contexts) {
        if (context.environmentId === environmentId) this.contexts.delete(id);
      }
    };
    this.workerHub.on('environment_disconnected', this.onEnvironmentDisconnected);
  }

  #create(environmentId, workspace) {
    const record = {
      id: crypto.randomUUID(),
      environmentId: String(environmentId),
      workspaceId: String(workspace.workspace_id),
      kind: String(workspace.kind),
      root: String(workspace.root),
      createdAt: new Date().toISOString(),
    };
    this.contexts.set(record.id, record);
    return publicContext(record);
  }

  async createProjectless(environmentId = null) {
    const environment = this.environmentRegistry.resolve(environmentId);
    const workspace = await this.workerHub.call(
      environment.id,
      'create_projectless_workspace',
      {},
      { timeoutMs: 10_000 },
    );
    return this.#create(environment.id, workspace);
  }

  createRegistered(environmentId, workspace) {
    return this.#create(environmentId, workspace);
  }

  resolve(contextId) {
    const id = String(contextId || '');
    const record = this.contexts.get(id);
    if (!record) {
      throw new Error('Unknown or expired workspace_context: ' + id);
    }
    return publicContext(record);
  }

  close() {
    this.contexts.clear();
    this.workerHub.off(
      'environment_disconnected',
      this.onEnvironmentDisconnected,
    );
  }
}
