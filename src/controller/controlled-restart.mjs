import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultPolicyFile = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'config', 'restart-allowlist.json',
);

function readAllowedIdentities(value, name) {
  if (!Array.isArray(value) || value.some((id) =>
    typeof id !== 'string' || !id.trim() || id !== id.trim() ||
    id === '*' || id.length > 256
  ) || new Set(value).size !== value.length) {
    throw new Error('Invalid restart allowlist: ' + name + ' must contain unique, exact environment IDs.');
  }
  return value;
}

export function readRestartAllowlist(file = defaultPolicyFile) {
  // Reload on every request. Missing or malformed configuration fails closed.
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      Object.keys(value).sort().join(',') !== 'controller_service_groups,workers') {
    throw new Error('Invalid restart allowlist: only controller_service_groups and workers are allowed.');
  }
  return {
    controller_service_groups: readAllowedIdentities(value.controller_service_groups, 'controller_service_groups'),
    workers: readAllowedIdentities(value.workers, 'workers'),
  };
}

export class ControlledRestart {
  constructor({ environmentRegistry, workerHub, controllerEnvironmentId,
    requestControllerRestart = null, policyFile = defaultPolicyFile } = {}) {
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.controllerEnvironmentId = controllerEnvironmentId;
    this.requestControllerRestart = requestControllerRestart;
    this.policyFile = policyFile;
  }

  async request({ component, environment_id: environmentId }) {
    const policy = readRestartAllowlist(this.policyFile);
    const list = component === 'controller_service_group'
      ? policy.controller_service_groups
      : component === 'worker' ? policy.workers : null;
    if (!list) throw new Error('Unsupported CCM restart component.');
    if (!list.includes(environmentId)) {
      throw new Error('CCM restart is not allowed for ' + component + ' in ' + environmentId + '.');
    }

    if (component === 'controller_service_group') {
      if (environmentId !== this.controllerEnvironmentId ||
          typeof this.requestControllerRestart !== 'function') {
        throw new Error('Controller restart requires the supervised local Controller identity.');
      }
      this.requestControllerRestart();
    } else {
      const environment = this.environmentRegistry.resolve(environmentId);
      if (environment.backend !== 'remote-worker' ||
          this.workerHub.environmentStatus(environmentId).state !== 'normal') {
        throw new Error('CCM restart requires a connected, healthy Remote Worker.');
      }
      await this.workerHub.call(environmentId, 'restart_self', {});
    }
    return { accepted: true, component, environment_id: environmentId,
      message: 'Restart requested. Verify reconnection and health before reporting completion.' };
  }
}
