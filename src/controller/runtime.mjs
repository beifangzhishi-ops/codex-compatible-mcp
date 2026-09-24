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
import { TrustedPackageScriptStore } from './trusted-package-script-store.mjs';
import { defaultControllerStateFile } from './controller-state.mjs';
import { WorkerQuarantinePolicy } from './worker-quarantine-policy.mjs';

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
  const workerQuarantinePolicy = options.workerQuarantinePolicy ||
    new WorkerQuarantinePolicy({
      file: options.workerQuarantinePolicyFile ||
        path.join(installRoot, 'config', 'worker-quarantine-errors.json'),
      pollIntervalMs: options.workerQuarantinePolicyPollIntervalMs,
      log: options.workerQuarantinePolicyLog,
    });
  const workerHub = options.workerHub || new WorkerHub({
    environmentRegistry,
    host: options.workerHost,
    port: options.workerPort,
    takeoverToken: options.workerTakeoverToken,
    quarantinePolicy: workerQuarantinePolicy,
  });
  const approvalManager = options.approvalManager || new ApprovalManager({
    audit,
    ttlMs: process.env.CCM_APPROVAL_TTL_MS,
  });
  const execPolicyStore = options.execPolicyStore || new ExecPolicyStore({
    stateFile: options.execPolicyStateFile ||
      defaultControllerStateFile('exec-policy.json'),
    audit,
  });
  const trustedPackageScriptStore = options.trustedPackageScriptStore ||
    new TrustedPackageScriptStore({
      stateFile: options.trustedPackageScriptStateFile ||
        defaultControllerStateFile('trusted-package-scripts.json'),
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
    trustedPackageScriptStore,
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
    trustedPackageScriptStore,
    audit,
    workspaceContextManager,
    processManager,
    fileService,
    fileTransferStore,
    planManager,
    async start() {
      workerQuarantinePolicy.start();
      try {
        await workerHub.start();
      } catch (error) {
        workerQuarantinePolicy.close();
        throw error;
      }
    },
    async close() {
      try {
        await processManager.close();
        fileTransferStore.close();
        execPolicyStore?.close?.();
        trustedPackageScriptStore?.close?.();
        await planManager?.close();
        workspaceContextManager.close();
        await workerHub.close();
      } finally {
        workerQuarantinePolicy.close();
      }
    },
  };
}
