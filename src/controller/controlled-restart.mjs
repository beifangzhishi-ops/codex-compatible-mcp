import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEFAULT_CCM_CONFIG_FILE } from '../runtime/ccm-config.mjs';

const defaultPolicyFile = DEFAULT_CCM_CONFIG_FILE;

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
  const value = JSON.parse(fs.readFileSync(file, 'utf8')).restart_allowlist;
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
    requestControllerRestart = null, armWorkerRestart = () => {},
    recoveryTimeoutMs = 60_000, policyFile = defaultPolicyFile } = {}) {
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.controllerEnvironmentId = controllerEnvironmentId;
    this.requestControllerRestart = requestControllerRestart;
    this.policyFile = policyFile;
    this.armWorkerRestart = armWorkerRestart;
    this.recoveryTimeoutMs = recoveryTimeoutMs;
    this.operations = new Map();
  }

  async #restartWorker(environmentId) {
    // 只淘汰终态记录，避免重复请求导致无界增长。
    for (const [id, value] of this.operations) {
      if (this.operations.size < 128) break;
      if (['recovered', 'failed'].includes(value.state)) this.operations.delete(id);
    }
    if (this.operations.size >= 128) throw new Error('进行中的重启过多。');
    const operation = { operation_id: randomUUID(), component: 'worker',
      environment_id: environmentId, state: 'requested', created_at: new Date().toISOString() };
    this.operations.set(operation.operation_id, operation);
    let disconnected = false;
    let timer;
    const finish = (state, error) => {
      operation.state = state;
      operation.completed_at = new Date().toISOString();
      if (error) operation.error = error;
      clearTimeout(timer);
      this.workerHub.off?.('environment_disconnected', onDisconnected);
      this.workerHub.off?.('environment_connected', onConnected);
    };
    const onDisconnected = (id) => {
      if (id !== environmentId) return;
      disconnected = true;
      operation.state = 'reconnecting';
    };
    const onConnected = (id) => {
      if (id === environmentId && disconnected &&
          this.workerHub.environmentStatus(id).state === 'normal') finish('recovered');
    };
    this.workerHub.on?.('environment_disconnected', onDisconnected);
    this.workerHub.on?.('environment_connected', onConnected);
    timer = setTimeout(() => finish('failed', '等待 Worker 断开并重新注册超时。'), this.recoveryTimeoutMs);
    timer.unref?.();
    try {
      await this.workerHub.call(environmentId, 'restart_self', {});
      this.armWorkerRestart(environmentId);
    } catch (error) {
      finish('failed', String(error?.message || error));
      throw error;
    }
    return { ...operation, accepted: true, message: '已受理重启；请用 list_projects 检查目标 Worker 的连接时间变化及健康状态。' };
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
      const active = [...this.operations.values()].find((value) =>
        value.environment_id === environmentId && ['requested', 'reconnecting'].includes(value.state));
      if (active) return { ...active, accepted: true, message: '重启已在进行；请用 list_projects 检查 Worker 是否重新连接。' };
      const environment = this.environmentRegistry.resolve(environmentId);
      if (environment.backend !== 'remote-worker' ||
          this.workerHub.environmentStatus(environmentId).state !== 'normal') {
        throw new Error('CCM restart requires a connected, healthy Remote Worker.');
      }
      return this.#restartWorker(environmentId);
    }
    return { accepted: true, component, environment_id: environmentId,
      message: 'Restart requested. Verify reconnection and health before reporting completion.' };
  }
}
