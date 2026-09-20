import { createLocalEnvironmentRegistry } from './environment-registry.mjs';
import { ExecutorRegistry } from './executors/executor-registry.mjs';
import { NativeEnvironmentExecutor } from './executors/native-executor.mjs';
import { ProcessManager } from './process-manager.mjs';
import { NativeSandboxBackend } from './sandbox/native-sandbox.mjs';
import { NativeFileService } from './filesystem/native-file-service.mjs';

export function createWorkerRuntime(options = {}) {
  const environmentRegistry = options.environmentRegistry ||
    createLocalEnvironmentRegistry(options.environment);
  const sandboxBackend = options.sandboxBackend ||
    new NativeSandboxBackend(options.sandbox);

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
  });
  const fileService = options.fileService || new NativeFileService({
    environmentRegistry,
    maxViewImageBytes: options.maxViewImageBytes,
    maxSendFileBytes: options.maxSendFileBytes,
  });

  return {
    environmentRegistry,
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
