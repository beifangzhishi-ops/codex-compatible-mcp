import fs from 'node:fs/promises';
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
const healthIntervalMs = Number(
  process.env.CCM_WORKER_HEALTH_INTERVAL_MS || 5_000,
);
const healthPath = path.join(installRoot, '.state', 'ccm-worker-health.json');
let stopping = false;
let activeClient = null;
let healthTimer = null;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeHealth(state, detail = null) {
  const environmentId = runtime.environmentRegistry.defaultEnvironmentId;
  const payload = {
    pid: process.pid,
    state,
    environment_id: environmentId,
    worker_id: process.env.CCM_WORKER_ID || environmentId,
    controller_host: process.env.CCM_WORKER_HUB_CONNECT_HOST ||
      process.env.CCM_WORKER_HUB_HOST || '127.0.0.1',
    controller_port: Number(process.env.CCM_WORKER_HUB_PORT || 18301),
    updated_at: new Date().toISOString(),
    ...(detail ? { detail: String(detail) } : {}),
  };
  await fs.mkdir(path.dirname(healthPath), { recursive: true });
  await fs.writeFile(healthPath, JSON.stringify(payload) + '\n', 'utf8');
}

async function setHealth(state, detail = null) {
  try {
    await writeHealth(state, detail);
  } catch (error) {
    console.error(
      'CCM Remote Worker health write failed: ' +
      String(error?.message || error),
    );
  }
}

function stopHealthHeartbeat() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

function startHealthHeartbeat() {
  stopHealthHeartbeat();
  healthTimer = setInterval(() => {
    setHealth('connected').catch(() => {});
  }, healthIntervalMs);
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  stopHealthHeartbeat();
  await setHealth('stopping');
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
    await setHealth('connecting');
    await client.connect();
    const environmentId = runtime.environmentRegistry.defaultEnvironmentId;
    await setHealth('connected');
    startHealthHeartbeat();
    console.log(
      'CCM Remote Worker ' + client.workerId +
      ' connected for environment ' + environmentId + '.',
    );
    await client.waitUntilClosed();
  } catch (error) {
    if (!stopping) {
      await setHealth('connection_failed', error?.message || error);
      console.error(
        'CCM Remote Worker connection failed: ' +
        String(error?.message || error),
      );
    }
  } finally {
    stopHealthHeartbeat();
    if (!stopping) await setHealth('disconnected');
    runtime.processManager.terminateAll();
    if (activeClient === client) activeClient = null;
  }

  if (!stopping) await sleep(reconnectDelayMs);
}

runtime.close();
