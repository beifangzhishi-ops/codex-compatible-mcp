import { createLocalEnvironmentRegistry } from './environment-registry.mjs';
import { ExecutorRegistry } from './executors/executor-registry.mjs';
import { NativeEnvironmentExecutor } from './executors/native-executor.mjs';
import { ProcessManager } from './process-manager.mjs';
import { NativeSandboxBackend } from './sandbox/native-sandbox.mjs';
import { NativeFileService } from './filesystem/native-file-service.mjs';
import { WorkspaceRegistry } from './workspace-registry.mjs';
import { ChildProxyPolicy } from './child-proxy-policy.mjs';

export function createWorkerRuntime(options = {}) {
  const environmentRegistry = options.environmentRegistry ||
    createLocalEnvironmentRegistry(options.environment);
  const sandboxBackend = options.sandboxBackend ||
    new NativeSandboxBackend(options.sandbox);
  const workspaceRegistry = options.workspaceRegistry || new WorkspaceRegistry({
    environmentRegistry,
    stateFile: options.workspaceStateFile,
    projectlessRoot: options.projectlessRoot,
    seedBootstrapWorkspace: options.seedBootstrapWorkspace !== false,
  });
  const childProxyPolicy = options.childProxyPolicy || new ChildProxyPolicy({
    file: options.childProxyStateFile,
    log: options.log,
  });

  const executorRegistry = options.executorRegistry || new ExecutorRegistry();
  if (!options.executorRegistry) {
    executorRegistry.register(
      'native',
      new NativeEnvironmentExecutor({ sandboxBackend, childProxyPolicy }),
    );
  }

  const processManager = options.processManager || new ProcessManager({
    environmentRegistry,
    executorRegistry,
    workspaceRegistry,
    processResultTtlMs: options.processResultTtlMs,
  });
  const fileService = options.fileService || new NativeFileService({
    environmentRegistry,
    workspaceRegistry,
    maxViewImageBytes: options.maxViewImageBytes,
    maxSendFileBytes: options.maxSendFileBytes,
    maxReceiveFileBytes: options.maxReceiveFileBytes,
  });

  return {
    environmentRegistry,
    workspaceRegistry,
    executorRegistry,
    sandboxBackend,
    childProxyPolicy,
    processManager,
    fileService,
    close() {
      processManager.terminateAll();
    },
  };
}

export const createRuntime = createWorkerRuntime;
