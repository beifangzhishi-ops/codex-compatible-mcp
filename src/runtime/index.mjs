import { createLocalEnvironmentRegistry } from './environment-registry.mjs';
import { ExecutorRegistry } from './executors/executor-registry.mjs';
import { LocalEnvironmentExecutor } from './executors/local-executor.mjs';
import { ProcessManager } from './process-manager.mjs';
import { NativeSandboxBackend } from './sandbox/native-sandbox.mjs';

export function createRuntime(options = {}) {
  const environmentRegistry = options.environmentRegistry ||
    createLocalEnvironmentRegistry(options.environment);
  const sandboxBackend = options.sandboxBackend ||
    new NativeSandboxBackend(options.sandbox);

  const executorRegistry = options.executorRegistry || new ExecutorRegistry();
  if (!options.executorRegistry) {
    executorRegistry.register(
      'local',
      new LocalEnvironmentExecutor({ sandboxBackend }),
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
