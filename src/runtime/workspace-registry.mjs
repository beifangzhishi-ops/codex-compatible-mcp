import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function safeWorkspaceId(value) {
  return String(value || 'workspace')
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';
}

function defaultProjectlessRoot() {
  return process.env.CCM_PROJECTLESS_ROOT ||
    path.join(os.homedir(), 'Documents', 'CCM');
}

function defaultRegistryFile() {
  return process.env.CCM_WORKSPACE_REGISTRY_FILE || null;
}

function canonicalDirectory(value) {
  const requested = path.resolve(String(value || ''));
  const real = fs.realpathSync.native(requested);
  if (!fs.statSync(real).isDirectory()) {
    throw new Error('Workspace path is not a directory: ' + real);
  }
  return real;
}

function inspectDirectoryTarget(value, { allowMissing = false } = {}) {
  const requested = path.resolve(String(value || ''));
  if (fs.existsSync(requested)) {
    return {
      root: canonicalDirectory(requested),
      exists: true,
    };
  }
  if (!allowMissing) {
    throw new Error('Workspace path does not exist: ' + requested);
  }

  let ancestor = requested;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new Error('No existing ancestor for workspace path: ' + requested);
    }
    ancestor = parent;
  }
  if (!fs.statSync(ancestor).isDirectory()) {
    throw new Error('Workspace path ancestor is not a directory: ' + ancestor);
  }
  const realAncestor = fs.realpathSync.native(ancestor);
  const suffix = path.relative(ancestor, requested);
  return {
    root: path.resolve(realAncestor, suffix),
    exists: false,
  };
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function publicWorkspace(workspace) {
  return {
    workspace_id: workspace.id,
    kind: workspace.kind,
    root: workspace.root,
    created_at: workspace.createdAt,
  };
}

export class WorkspaceRegistry {
  constructor({
    environmentRegistry,
    stateFile = defaultRegistryFile(),
    projectlessRoot = defaultProjectlessRoot(),
    seedLegacyWorkspace = true,
  } = {}) {
    if (!environmentRegistry) {
      throw new Error('WorkspaceRegistry requires environmentRegistry.');
    }
    this.environmentRegistry = environmentRegistry;
    this.stateFile = stateFile || null;
    this.projectlessRoot = path.resolve(projectlessRoot);
    this.registered = new Map();
    this.projectless = new Map();
    this.#load();
    if (seedLegacyWorkspace) this.#seedLegacyWorkspace();
  }

  #load() {
    if (!this.stateFile || !fs.existsSync(this.stateFile)) return;
    const text = fs.readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    for (const value of parsed?.workspaces || []) {
      if (!value?.id || !value?.root) continue;
      this.registered.set(String(value.id), {
        id: String(value.id),
        kind: 'registered',
        root: String(value.root),
        createdAt: String(value.created_at || new Date().toISOString()),
      });
    }
    for (const value of parsed?.projectless_workspaces || []) {
      if (!value?.id || !value?.root) continue;
      this.projectless.set(String(value.id), {
        id: String(value.id),
        kind: 'projectless',
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
      workspaces: [...this.registered.values()].map((workspace) => ({
        id: workspace.id,
        root: workspace.root,
        created_at: workspace.createdAt,
      })),
      projectless_workspaces: [...this.projectless.values()].map((workspace) => ({
        id: workspace.id,
        root: workspace.root,
        created_at: workspace.createdAt,
      })),
    };
    fs.writeFileSync(
      this.stateFile,
      JSON.stringify(payload, null, 2) + '\n',
      'utf8',
    );
  }

  #seedLegacyWorkspace() {
    const environment = this.environmentRegistry.resolve();
    let root;
    try {
      root = canonicalDirectory(environment.cwd);
    } catch {
      return;
    }
    const existing = [...this.registered.values()].find(
      (workspace) => pathKey(workspace.root) === pathKey(root),
    );
    if (existing) return;

    let id = safeWorkspaceId(path.basename(root));
    if (this.registered.has(id)) id = 'legacy-' + id;
    this.registered.set(id, {
      id,
      kind: 'registered',
      root,
      createdAt: new Date().toISOString(),
    });
    this.#persist();
  }

  list() {
    return [...this.registered.values()]
      .map(publicWorkspace)
      .sort((left, right) => left.workspace_id.localeCompare(right.workspace_id));
  }

  inspectPath(value, workspaceId = null, { createIfMissing = false } = {}) {
    if (!path.isAbsolute(String(value || ''))) {
      throw new Error('Workspace path must be absolute.');
    }
    const inspected = inspectDirectoryTarget(value, {
      allowMissing: Boolean(createIfMissing),
    });
    const root = inspected.root;
    const suggestedId = safeWorkspaceId(workspaceId || path.basename(root));
    return {
      workspace_id: suggestedId,
      root,
      exists: inspected.exists,
      create_required: !inspected.exists,
    };
  }

  register({
    workspace_id: workspaceId,
    path: workspacePath,
    create_if_missing: createIfMissing = false,
    approved_root: approvedRoot = null,
  } = {}) {
    let inspected = this.inspectPath(workspacePath, workspaceId, {
      createIfMissing,
    });
    if (approvedRoot != null &&
        pathKey(inspected.root) !== pathKey(approvedRoot)) {
      throw new Error(
        'Workspace path does not match the approved target.',
      );
    }
    if (!inspected.exists) {
      fs.mkdirSync(inspected.root, { recursive: true });
      const real = canonicalDirectory(inspected.root);
      if (approvedRoot != null && pathKey(real) !== pathKey(approvedRoot)) {
        throw new Error(
          'Created workspace path does not match the approved target.',
        );
      }
      inspected = {
        ...inspected,
        root: real,
        exists: true,
        create_required: false,
      };
    }
    const id = inspected.workspace_id;
    const sameRoot = [...this.registered.values()].find(
      (workspace) => pathKey(workspace.root) === pathKey(inspected.root),
    );
    if (sameRoot && sameRoot.id !== id) {
      throw new Error(
        'Workspace path is already registered as ' + sameRoot.id + '.',
      );
    }
    const existing = this.registered.get(id);
    if (existing && pathKey(existing.root) !== pathKey(inspected.root)) {
      throw new Error('Workspace id already exists: ' + id);
    }
    if (existing) return publicWorkspace(existing);

    const workspace = {
      id,
      kind: 'registered',
      root: inspected.root,
      createdAt: new Date().toISOString(),
    };
    this.registered.set(id, workspace);
    this.#persist();
    return publicWorkspace(workspace);
  }

  createProjectless() {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const uuid = crypto.randomUUID();
    const root = path.join(this.projectlessRoot, date, uuid);
    fs.mkdirSync(root, { recursive: true });
    const workspace = {
      id: 'projectless-' + uuid,
      kind: 'projectless',
      root,
      createdAt: now.toISOString(),
    };
    this.projectless.set(workspace.id, workspace);
    this.#persist();
    return publicWorkspace(workspace);
  }

  resolve(workspaceId) {
    const id = String(workspaceId || '');
    const workspace = this.registered.get(id) || this.projectless.get(id);
    if (!workspace) throw new Error('Unknown workspace_id: ' + id);
    if (!fs.existsSync(workspace.root) || !fs.statSync(workspace.root).isDirectory()) {
      if (workspace.kind === 'projectless') {
        this.projectless.delete(id);
        this.#persist();
      }
      throw new Error('Workspace directory no longer exists: ' + workspace.root);
    }
    return publicWorkspace(workspace);
  }

  environmentFor(workspaceId, expectedRoot = null) {
    const base = this.environmentRegistry.resolve();
    const workspace = this.resolve(workspaceId);
    if (expectedRoot != null && pathKey(workspace.root) !== pathKey(expectedRoot)) {
      throw new Error(
        'Workspace root changed for ' + workspace.workspace_id +
        ': expected ' + expectedRoot + ', current ' + workspace.root + '.',
      );
    }
    return {
      ...base,
      cwd: workspace.root,
      workspaceRoots: [workspace.root],
      metadata: {
        ...(base.metadata || {}),
        workspaceId: workspace.workspace_id,
        workspaceKind: workspace.kind,
      },
    };
  }
}

export function resolveWorkspaceRelativePath(root, requested, label = 'path') {
  if (requested == null || requested === '') return path.resolve(root);
  if (path.isAbsolute(requested)) {
    throw new Error(label + ' must be relative to the selected workspace.');
  }
  const base = path.resolve(root);
  const resolved = path.resolve(base, requested);
  const relative = path.relative(base, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(label + ' escapes the selected workspace.');
  }
  return resolved;
}
