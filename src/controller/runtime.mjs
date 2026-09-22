import { EnvironmentRegistry } from '../runtime/environment-registry.mjs';
import { RemoteProcessManager } from '../runtime/remote-process-manager.mjs';
import { RemoteFileService } from '../runtime/filesystem/remote-file-service.mjs';
import { WorkerHub } from './worker-hub.mjs';
import { ApprovalManager } from './approval-manager.mjs';

export function createControllerRuntime(options = {}) {
  const environmentRegistry = options.environmentRegistry ||
    new EnvironmentRegistry({
      defaultEnvironmentId: options.defaultEnvironmentId || null,
      resolvePaths: false,
    });
  const workerHub = options.workerHub || new WorkerHub({
    environmentRegistry,
    host: options.workerHost,
    port: options.workerPort,
    takeoverToken: options.workerTakeoverToken,
  });
  const approvalManager = options.approvalManager || new ApprovalManager();
  const processManager = options.processManager || new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
  });
  const fileService = options.fileService || new RemoteFileService({
    environmentRegistry,
    workerHub,
  });

  return {
    environmentRegistry,
    workerHub,
    approvalManager,
    processManager,
    fileService,
    async start() {
      await workerHub.start();
    },
    async close() {
      await processManager.close();
      await workerHub.close();
    },
  };
}
