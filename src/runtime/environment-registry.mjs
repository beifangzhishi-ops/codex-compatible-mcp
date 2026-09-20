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

export class EnvironmentRegistry {
  constructor({ defaultEnvironmentId = null } = {}) {
    this.environments = new Map();
    this.defaultEnvironmentId = defaultEnvironmentId;
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
      cwd: path.resolve(environment.cwd || process.cwd()),
      workspaceRoots: (environment.workspaceRoots || [environment.cwd || process.cwd()])
        .map((root) => path.resolve(root)),
      shell: environment.shell || defaultShell(platform),
      permissionProfile: environment.permissionProfile || 'workspace-write',
      capabilities: {
        exec: true,
        writeStdin: true,
        applyPatch: false,
        viewImage: false,
        ...(environment.capabilities || {}),
      },
      backend: environment.backend || 'local',
      metadata: { ...(environment.metadata || {}) },
    };
    this.environments.set(normalized.id, normalized);
    if (!this.defaultEnvironmentId) this.defaultEnvironmentId = normalized.id;
    return normalized;
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
      cwd: environment.cwd,
      workspace_roots: environment.workspaceRoots,
      shell: environment.shell,
      permission_profile: environment.permissionProfile,
      capabilities: environment.capabilities,
      backend: environment.backend,
      is_default: environment.id === this.defaultEnvironmentId,
    }));
  }
}

export function createLocalEnvironmentRegistry({
  id = process.env.CCM_ENVIRONMENT_ID || '6v1f',
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
    backend: 'local',
  });
  return registry;
}
