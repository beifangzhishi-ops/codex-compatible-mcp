import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControllerRuntime } from './controller/runtime.mjs';
import { createHttpController } from './controller/mcp-http-server.mjs';
import { LocalWorkerSupervisor } from './controller/local-worker-supervisor.mjs';
import { createToolRegistry } from './tools/index.mjs';

const installRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const localEnvironmentId = process.env.CCM_ENVIRONMENT_ID || os.hostname();
const localWorkerTakeoverToken = randomUUID();
const runtime = createControllerRuntime({
  defaultEnvironmentId: localEnvironmentId,
  workerTakeoverToken: localWorkerTakeoverToken,
  workspaceContextStateFile:
    process.env.CCM_WORKSPACE_CONTEXT_FILE ||
    path.join(installRoot, '.state', 'workspace-contexts.json'),
  planStateDir: path.join(installRoot, '.state', 'plans'),
});
await runtime.start();

let localWorkerSupervisor = null;
const spawnLocalWorker = process.env.CCM_SPAWN_LOCAL_WORKER !== '0';
if (spawnLocalWorker) {
  const agentPath = fileURLToPath(new URL('./worker/agent.mjs', import.meta.url));
  const logPath = fileURLToPath(
    new URL('../logs/ccm-local-worker.log', import.meta.url),
  );
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const appendLog = (message) => {
    fs.appendFileSync(
      logPath,
      '[' + new Date().toISOString() + '] ' + message + '\n',
      'utf8',
    );
  };
  localWorkerSupervisor = new LocalWorkerSupervisor({
    workerHub: runtime.workerHub,
    environmentId: localEnvironmentId,
    agentPath,
    takeoverToken: localWorkerTakeoverToken,
    log: appendLog,
    onOutput: (stream, chunk) => {
      const text = String(chunk);
      fs.appendFileSync(
        logPath,
        '[' + new Date().toISOString() + '] [' + stream + '] ' + text,
        'utf8',
      );
      if (stream === 'stderr') process.stderr.write(chunk);
      else process.stdout.write(chunk);
    },
  });
  try {
    await localWorkerSupervisor.start();
  } catch (error) {
    await localWorkerSupervisor.stop().catch(() => {});
    await runtime.close();
    throw error;
  }
}

const { registry: toolRegistry, codeModeManager } = createToolRegistry(runtime);
const controller = createHttpController({
  toolRegistry,
  runtime,
  healthProvider: () => {
    const localWorker = localWorkerSupervisor?.status() || {
      enabled: false,
      state: 'disabled',
    };
    return {
      status:
        localWorker.enabled && localWorker.state !== 'connected'
          ? 'degraded'
          : 'ok',
      local_worker: localWorker,
    };
  },
});
await controller.start();

console.log('CCM listening at ' + controller.endpoint);
console.log(
  'CCM WorkerHub listening at ' +
  runtime.workerHub.host + ':' + runtime.workerHub.address.port,
);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await localWorkerSupervisor?.stop().catch(() => {});
  codeModeManager.close();
  await controller.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
