import { createLocalEnvironmentRegistry } from './environment-registry.mjs';
import { ExecutorRegistry } from './executors/executor-registry.mjs';
import { NativeEnvironmentExecutor } from './executors/native-executor.mjs';
import { ProcessManager } from './process-manager.mjs';
import { NativeSandboxBackend } from './sandbox/native-sandbox.mjs';
import { NativeFileService } from './filesystem/native-file-service.mjs';
import { WorkspaceRegistry } from './workspace-registry.mjs';

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

  const executorRegistry = options.executorRegistry || new ExecutorRegistry();
  if (!options.executorRegistry) {
    executorRegistry.register(
      'native',
      new NativeEnvironmentExecutor({ sandboxBackend }),
    );
  }

  const processManager = options.processManager || new ProcessManager({
    environmentRegistry,
    executorRegistry,
    workspaceRegistry,
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
    processManager,
    fileService,
    close() {
      processManager.terminateAll();
    },
  };
}

export const createRuntime = createWorkerRuntime;
