import { createLocalEnvironmentRegistry } from './environment-registry.mjs';
import { ExecutorRegistry } from './executors/executor-registry.mjs';
import { NativeEnvironmentExecutor } from './executors/native-executor.mjs';
import { ProcessManager } from './process-manager.mjs';
import { NativeSandboxBackend } from './sandbox/native-sandbox.mjs';
import { CodexWindowsSandboxBackend, resolveNativeCodexRuntime } from './sandbox/codex-windows-sandbox.mjs';
import { provisionCodexRuntimeHome } from './sandbox/codex-runtime-home.mjs';
import { NativeFileService } from './filesystem/native-file-service.mjs';
import { WorkerTransferService } from './filesystem/transfer-worker.mjs';
import { WorkspaceRegistry } from './workspace-registry.mjs';
import { ChildProxyPolicy } from './child-proxy-policy.mjs';

export function createWorkerRuntime(options = {}) {
  const environmentRegistry = options.environmentRegistry ||
    createLocalEnvironmentRegistry(options.environment);
  const sandboxBackend = options.sandboxBackend || (() => {
    if (options.codexSandbox === true) {
      if (process.platform !== 'win32') {
        throw new Error('Upstream Codex Elevated Sandbox requires Windows.');
      }
      // This is the trusted Worker-side construction path, not a user-command
      // option. Require a complete Codex CLI installation before accepting work.
      resolveNativeCodexRuntime();
      return new CodexWindowsSandboxBackend({
        codexHome: provisionCodexRuntimeHome(),
      });
    }
    return new NativeSandboxBackend(options.sandbox);
  })();
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
  const transferService = options.transferService || new WorkerTransferService({
    workspaceRegistry, stateDir: options.transferStateDir,
  });

  return {
    environmentRegistry,
    workspaceRegistry,
    executorRegistry,
    sandboxBackend,
    childProxyPolicy,
    processManager,
    fileService,
    transferService,
    close() {
      processManager.terminateAll();
    },
  };
}

export const createRuntime = createWorkerRuntime;
