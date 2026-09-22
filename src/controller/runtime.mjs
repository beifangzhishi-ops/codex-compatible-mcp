import { EnvironmentRegistry } from '../runtime/environment-registry.mjs';
import { RemoteProcessManager } from '../runtime/remote-process-manager.mjs';
import { RemoteFileService } from '../runtime/filesystem/remote-file-service.mjs';
import { WorkerHub } from './worker-hub.mjs';
import { ApprovalManager } from './approval-manager.mjs';
import { WorkspaceContextManager } from './workspace-context-manager.mjs';

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
  const workspaceContextManager = options.workspaceContextManager ||
    new WorkspaceContextManager({ environmentRegistry, workerHub });
  const processManager = options.processManager || new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceContextManager,
  });
  const fileService = options.fileService || new RemoteFileService({
    environmentRegistry,
    workerHub,
    workspaceContextManager,
  });

  return {
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceContextManager,
    processManager,
    fileService,
    async start() {
      await workerHub.start();
    },
    async close() {
      await processManager.close();
      workspaceContextManager.close();
      await workerHub.close();
    },
  };
}
