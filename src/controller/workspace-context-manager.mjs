import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
  constructor({ environmentRegistry, workerHub, stateFile = null } = {}) {
    if (!environmentRegistry || !workerHub) {
      throw new Error(
        'WorkspaceContextManager requires environmentRegistry and workerHub.',
      );
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.stateFile = stateFile || null;
    this.contexts = new Map();
    this.#load();
  }

  #load() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    const text = fs.readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    for (const value of parsed?.contexts || []) {
      if (!value?.id || !value?.environment_id || !value?.workspace_id ||
          !value?.kind || !value?.root) continue;
      this.contexts.set(String(value.id), {
        id: String(value.id),
        environmentId: String(value.environment_id),
        workspaceId: String(value.workspace_id),
        kind: String(value.kind),
        root: String(value.root),
        createdAt: String(value.created_at || new Date().toISOString()),
      });
    }
  }

  #persist() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const payload = {
      version: 1,
      contexts: [...this.contexts.values()].map((record) => ({
        id: record.id,
        environment_id: record.environmentId,
        workspace_id: record.workspaceId,
        kind: record.kind,
        root: record.root,
        created_at: record.createdAt,
      })),
    };
    fs.writeFileSync(
      this.stateFile,
      JSON.stringify(payload, null, 2) + '\n',
      'utf8',
    );
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
    this.#persist();
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
    this.#persist();
  }
}
