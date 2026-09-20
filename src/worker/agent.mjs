import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerRuntime } from '../runtime/index.mjs';
import { RemoteWorkerClient } from './remote-worker-client.mjs';

const installRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
process.env.CCM_INSTALL_ROOT ||= installRoot;

const runtime = createWorkerRuntime();
const reconnectDelayMs = Number(process.env.CCM_WORKER_RECONNECT_MS || 1000);
let stopping = false;
let activeClient = null;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  await activeClient?.close().catch(() => {});
  runtime.close();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

while (!stopping) {
  const client = new RemoteWorkerClient({
    runtime,
    workerId: process.env.CCM_WORKER_ID,
  });
  activeClient = client;
  try {
    await client.connect();
    const environmentId = runtime.environmentRegistry.defaultEnvironmentId;
    console.log(
      'CCM Remote Worker ' + client.workerId +
      ' connected for environment ' + environmentId + '.',
    );
    await client.waitUntilClosed();
  } catch (error) {
    if (!stopping) {
      console.error(
        'CCM Remote Worker connection failed: ' +
        String(error?.message || error),
      );
    }
  } finally {
    runtime.processManager.terminateAll();
    if (activeClient === client) activeClient = null;
  }

  if (!stopping) await sleep(reconnectDelayMs);
}

runtime.close();
