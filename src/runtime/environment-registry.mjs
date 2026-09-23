import os from 'node:os';
import path from 'node:path';

function normalizePlatform(value = process.platform) {
  if (value === 'win32' || value === 'windows') return 'windows';
  if (value === 'darwin' || value === 'macos') return 'macos';
  return 'linux';
}

function defaultShell(platform) {
  if (platform === 'windows') {
    return { type: 'powershell', path: 'powershell.exe' };
  }
  return { type: 'bash', path: '/bin/bash' };
}

function publicFilesystemAccess(permissionProfile) {
  if (permissionProfile === 'read-only') {
    return {
      read_scope: 'host',
      write_scope: 'none',
    };
  }
  if (permissionProfile === 'workspace-write') {
    return {
      read_scope: 'host',
      write_scope: 'workspace',
    };
  }
  if (permissionProfile === 'full-access') {
    return {
      read_scope: 'host',
      write_scope: 'host',
    };
  }
  return {
    read_scope: 'restricted',
    write_scope: 'restricted',
  };
}

export class EnvironmentRegistry {
  constructor({
    defaultEnvironmentId = null,
    resolvePaths = true,
  } = {}) {
    this.environments = new Map();
    this.defaultEnvironmentId = defaultEnvironmentId;
    this.resolvePaths = resolvePaths;
  }

  register(environment) {
    if (!environment?.id) throw new Error('Environment id is required.');
    if (this.environments.has(environment.id)) {
      throw new Error(`Environment already registered: ${environment.id}`);
    }
    const platform = normalizePlatform(environment.platform);
    const normalized = {
      id: String(environment.id),
      name: String(environment.name || environment.id),
      platform,
      cwd: this.resolvePaths
        ? path.resolve(environment.cwd || process.cwd())
        : String(environment.cwd || ''),
      workspaceRoots: (environment.workspaceRoots || [environment.cwd || process.cwd()])
        .map((root) => this.resolvePaths ? path.resolve(root) : String(root)),
      shell: environment.shell || defaultShell(platform),
      permissionProfile: environment.permissionProfile || 'workspace-write',
      capabilities: {
        exec: true,
        writeStdin: true,
        applyPatch: false,
        viewImage: false,
        sendFile: false,
        ...(environment.capabilities || {}),
      },
      backend: environment.backend || 'native',
      metadata: { ...(environment.metadata || {}) },
    };
    this.environments.set(normalized.id, normalized);
    if (!this.defaultEnvironmentId) this.defaultEnvironmentId = normalized.id;
    return normalized;
  }

  unregister(environmentId) {
    const removed = this.environments.delete(environmentId);
    if (removed && this.defaultEnvironmentId === environmentId) {
      this.defaultEnvironmentId = this.environments.keys().next().value || null;
    }
    return removed;
  }

  resolve(environmentId = null) {
    const id = environmentId || this.defaultEnvironmentId;
    const environment = id ? this.environments.get(id) : null;
    if (!environment) throw new Error(`Unknown environment: ${id || '(none)'}`);
    return environment;
  }

  listPublic() {
    return [...this.environments.values()].map((environment) => ({
      id: environment.id,
      name: environment.name,
      platform: environment.platform,
      shell: environment.shell,
      capabilities: environment.capabilities,
      filesystem_access: publicFilesystemAccess(environment.permissionProfile),
      backend: environment.backend,
      is_default: environment.id === this.defaultEnvironmentId,
    }));
  }
}

export function createLocalEnvironmentRegistry({
  id = process.env.CCM_ENVIRONMENT_ID || os.hostname(),
  cwd = process.env.CCM_WORKSPACE || process.cwd(),
  permissionProfile = process.env.CCM_PERMISSION_PROFILE || 'workspace-write',
} = {}) {
  const registry = new EnvironmentRegistry({ defaultEnvironmentId: id });
  registry.register({
    id,
    name: os.hostname(),
    platform: process.platform,
    cwd,
    workspaceRoots: [cwd],
    permissionProfile,
    capabilities: {
      exec: true,
      writeStdin: true,
      applyPatch: true,
      viewImage: true,
      sendFile: true,
    },
    backend: 'native',
  });
  return registry;
}
