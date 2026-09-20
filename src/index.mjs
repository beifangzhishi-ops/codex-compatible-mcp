import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createControllerRuntime } from './controller/runtime.mjs';
import { createHttpController } from './controller/mcp-http-server.mjs';
import { ToolRegistry } from './tools/tool-registry.mjs';
import { registerCoreTools } from './tools/core-tools.mjs';

const runtime = createControllerRuntime();
await runtime.start();

let localWorker = null;
const spawnLocalWorker = process.env.CCM_SPAWN_LOCAL_WORKER !== '0';
if (spawnLocalWorker) {
  const agentPath = fileURLToPath(new URL('./worker/agent.mjs', import.meta.url));
  const hubAddress = runtime.workerHub.address;
  localWorker = spawn(process.execPath, [agentPath], {
    env: {
      ...process.env,
      CCM_WORKER_HUB_HOST: runtime.workerHub.host,
      CCM_WORKER_HUB_PORT: String(hubAddress.port),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });

  const environmentId = process.env.CCM_ENVIRONMENT_ID || '6v1f';
  const connected = await runtime.workerHub.waitForEnvironment(environmentId, 10_000);
  if (!connected) {
    localWorker.kill();
    await runtime.close();
    throw new Error('Local Remote Worker failed to register environment ' + environmentId + '.');
  }
}

const toolRegistry = registerCoreTools(new ToolRegistry(), runtime);
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
  await controller.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
