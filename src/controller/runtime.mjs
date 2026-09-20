import { EnvironmentRegistry } from '../runtime/environment-registry.mjs';
import { RemoteProcessManager } from '../runtime/remote-process-manager.mjs';
import { WorkerHub } from './worker-hub.mjs';

export function createControllerRuntime(options = {}) {
  const environmentRegistry = options.environmentRegistry ||
    new EnvironmentRegistry({ resolvePaths: false });
  const workerHub = options.workerHub || new WorkerHub({
    environmentRegistry,
    host: options.workerHost,
    port: options.workerPort,
  });
  const processManager = options.processManager || new RemoteProcessManager({
    environmentRegistry,
    workerHub,
  });

  return {
    environmentRegistry,
    workerHub,
    processManager,
    async start() {
      await workerHub.start();
    },
    async close() {
      await processManager.close();
      await workerHub.close();
    },
  };
}
