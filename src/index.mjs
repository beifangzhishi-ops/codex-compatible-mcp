import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createControllerRuntime } from './controller/runtime.mjs';
import { createHttpController } from './controller/mcp-http-server.mjs';
import { createToolRegistry } from './tools/index.mjs';

const localEnvironmentId = process.env.CCM_ENVIRONMENT_ID || os.hostname();
const localWorkerTakeoverToken = randomUUID();
const runtime = createControllerRuntime({
  defaultEnvironmentId: localEnvironmentId,
  workerTakeoverToken: localWorkerTakeoverToken,
});
await runtime.start();

let localWorker = null;
const spawnLocalWorker = process.env.CCM_SPAWN_LOCAL_WORKER !== '0';
if (spawnLocalWorker) {
  const agentPath = fileURLToPath(new URL('./worker/agent.mjs', import.meta.url));
  const hubAddress = runtime.workerHub.address;
  localWorker = spawn(process.execPath, [agentPath], {
    env: {
      ...process.env,
      CCM_WORKER_HUB_CONNECT_HOST:
        runtime.workerHub.host === '0.0.0.0'
          ? '127.0.0.1'
          : runtime.workerHub.host === '::'
            ? '::1'
            : runtime.workerHub.host,
      CCM_WORKER_HUB_PORT: String(hubAddress.port),
      CCM_WORKER_TAKEOVER_TOKEN: localWorkerTakeoverToken,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  const connected = await runtime.workerHub.waitForEnvironment(localEnvironmentId, 10_000);
  if (!connected) {
    localWorker.kill();
    await runtime.close();
    throw new Error(
      'Local Remote Worker failed to register environment ' +
      localEnvironmentId + '.',
    );
  }
}

const { registry: toolRegistry, codeModeManager } = createToolRegistry(runtime);
const controller = createHttpController({ toolRegistry, runtime });
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
  if (localWorker && !localWorker.killed) localWorker.kill();
  codeModeManager.close();
  await controller.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
