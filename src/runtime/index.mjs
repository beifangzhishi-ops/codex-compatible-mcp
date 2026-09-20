import { createLocalEnvironmentRegistry } from './environment-registry.mjs';
import { ExecutorRegistry } from './executors/executor-registry.mjs';
import { NativeEnvironmentExecutor } from './executors/native-executor.mjs';
import { ProcessManager } from './process-manager.mjs';
import { NativeSandboxBackend } from './sandbox/native-sandbox.mjs';

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

  return {
    environmentRegistry,
    executorRegistry,
    sandboxBackend,
    processManager,
    close() {
      processManager.terminateAll();
    },
  };
}

export const createRuntime = createWorkerRuntime;
