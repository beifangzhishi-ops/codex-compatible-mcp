import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function publicHandle(record) {
  return {
    workspace_handle: record.id,
    environment_id: record.environmentId,
    workspace_id: record.workspaceId,
    workspace_kind: record.kind,
    workspace_root: record.root,
    created_at: record.createdAt,
  };
}

export class WorkspaceHandleManager {
  constructor({ environmentRegistry, workerHub, stateFile = null } = {}) {
    if (!environmentRegistry || !workerHub) {
      throw new Error(
        'WorkspaceHandleManager requires environmentRegistry and workerHub.',
      );
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.stateFile = stateFile || null;
    this.handles = new Map();
    this.#load();
  }

  #load() {
    if (!this.stateFile) return;
    const previousFile = path.join(path.dirname(this.stateFile), 'workspace-contexts.json');
    const migrate = !fs.existsSync(this.stateFile) && fs.existsSync(previousFile);
    if (!migrate && !fs.existsSync(this.stateFile)) return;
    const text = fs.readFileSync(migrate ? previousFile : this.stateFile, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    for (const value of migrate ? (parsed?.contexts || []) : (parsed?.handles || [])) {
      if (!value?.id || !value?.environment_id || !value?.workspace_id ||
          !value?.kind || !value?.root) continue;
      this.handles.set(String(value.id), {
        id: String(value.id),
        environmentId: String(value.environment_id),
        workspaceId: String(value.workspace_id),
        kind: String(value.kind),
        root: String(value.root),
        createdAt: String(value.created_at || new Date().toISOString()),
      });
    }
    if (migrate) this.#persist();
  }

  #persist() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const payload = {
      version: 2,
      handles: [...this.handles.values()].map((record) => ({
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
    this.handles.set(record.id, record);
    this.#persist();
    return publicHandle(record);
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

  revokeRegistered(environmentId, workspaceId) {
    const removed = [];
    for (const [id, record] of this.handles) {
      if (record.kind === 'registered' &&
          record.environmentId === environmentId &&
          record.workspaceId === workspaceId) {
        removed.push([id, record]);
        this.handles.delete(id);
      }
    }
    try {
      this.#persist();
    } catch (error) {
      for (const [id, record] of removed) this.handles.set(id, record);
      throw error;
    }
    return removed.length;
  }

  resolve(handleId) {
    const id = String(handleId || '');
    const record = this.handles.get(id);
    if (!record) {
      throw new Error('Unknown or expired workspace_handle: ' + id);
    }
    return publicHandle(record);
  }

  close() {
    this.#persist();
  }
}
