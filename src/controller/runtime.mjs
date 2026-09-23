import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvironmentRegistry } from '../runtime/environment-registry.mjs';
import { RemoteProcessManager } from '../runtime/remote-process-manager.mjs';
import { RemoteFileService } from '../runtime/filesystem/remote-file-service.mjs';
import { WorkerHub } from './worker-hub.mjs';
import { ApprovalManager } from './approval-manager.mjs';
import { WorkspaceContextManager } from './workspace-context-manager.mjs';
import { FileTransferStore } from './file-transfer-store.mjs';
import { PlanManager } from './plan-manager.mjs';
import { createAuditLogger } from './audit-log.mjs';
import { ExecPolicyStore } from './exec-policy-store.mjs';

const installRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function createControllerRuntime(options = {}) {
  const audit = options.auditLogger || createAuditLogger({
    file: options.auditLogFile,
  });
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
  const approvalManager = options.approvalManager || new ApprovalManager({ audit });
  const execPolicyStore = options.execPolicyStore || new ExecPolicyStore({
    stateFile: options.execPolicyStateFile ||
      path.join(installRoot, '.state', 'exec-policy.json'),
    audit,
  });
  const workspaceContextManager = options.workspaceContextManager ||
    new WorkspaceContextManager({
      environmentRegistry,
      workerHub,
      stateFile: options.workspaceContextStateFile,
    });
  const processManager = options.processManager || new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceContextManager,
    execPolicyStore,
    audit,
  });
  const fileService = options.fileService || new RemoteFileService({
    environmentRegistry,
    workerHub,
    workspaceContextManager,
  });
  const fileTransferStore = options.fileTransferStore || new FileTransferStore({
    stateDir: options.fileTransferStateDir ||
      path.join(installRoot, '.state', 'file-transfers'),
  });
  const planManager = options.planManager || new PlanManager({
    stateDir: options.planStateDir || path.join(installRoot, '.state', 'plans'),
  });

  return {
    environmentRegistry,
    workerHub,
    approvalManager,
    execPolicyStore,
    audit,
    workspaceContextManager,
    processManager,
    fileService,
    fileTransferStore,
    planManager,
    async start() {
      await workerHub.start();
    },
    async close() {
      await processManager.close();
      fileTransferStore.close();
      execPolicyStore?.close?.();
      await planManager?.close();
      workspaceContextManager.close();
      await workerHub.close();
    },
  };
}
