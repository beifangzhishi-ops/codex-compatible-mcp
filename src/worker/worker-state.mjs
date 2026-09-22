import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function safeIdentity(value) {
  return String(value || 'worker').replace(/[^A-Za-z0-9_.-]/g, '_');
}

const atomicWriteQueues = new Map();

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function acquireWorkerInstanceLock({
  stateDir,
  identity,
  pid = process.pid,
  isProcessAlive = defaultProcessAlive,
  allowTakeover = false,
} = {}) {
  if (!stateDir) throw new Error('Worker instance lock requires stateDir.');
  if (!identity) throw new Error('Worker instance lock requires identity.');
  await fs.mkdir(stateDir, { recursive: true });

  const lockPath = path.join(
    stateDir,
    'ccm-worker-' + safeIdentity(identity) + '.lock',
  );
  const payload = JSON.stringify({
    pid,
    identity: String(identity),
    created_at: new Date().toISOString(),
  }) + '\n';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(payload, 'utf8');
      } finally {
        await handle.close();
      }

      let released = false;
      return {
        lockPath,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await fs.readFile(lockPath, 'utf8'));
            if (Number(current?.pid) !== Number(pid)) return;
          } catch (error) {
            if (error?.code === 'ENOENT') return;
            return;
          }
          await fs.unlink(lockPath).catch((error) => {
            if (error?.code !== 'ENOENT') throw error;
          });
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;

      let existingPid = null;
      try {
        const existing = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        existingPid = Number(existing?.pid);
      } catch {}

      if (Number.isInteger(existingPid) && existingPid > 0 &&
          await isProcessAlive(existingPid) && !allowTakeover) {
        const duplicate = new Error(
          'CCM Remote Worker identity ' + identity +
          ' is already running in pid ' + existingPid + '.',
        );
        duplicate.code = 'worker_instance_already_running';
        duplicate.pid = existingPid;
        throw duplicate;
      }

      await fs.unlink(lockPath).catch((unlinkError) => {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      });
    }
  }

  throw new Error('Unable to acquire CCM Remote Worker instance lock: ' + lockPath);
}

async function writeJsonAtomicOnce(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = filePath + '.' + process.pid + '.' + randomSuffix() + '.tmp';
  try {
    await fs.writeFile(tempPath, JSON.stringify(value) + '\n', 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tempPath, filePath);
        break;
      } catch (error) {
        const retryable = ['EPERM', 'EACCES', 'EBUSY'].includes(error?.code);
        if (!retryable || attempt >= 5) throw error;
        await sleep(5 * (attempt + 1));
      }
    }
  } finally {
    await fs.unlink(tempPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

export async function writeJsonAtomic(filePath, value) {
  const previous = atomicWriteQueues.get(filePath) || Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => writeJsonAtomicOnce(filePath, value));
  atomicWriteQueues.set(filePath, current);
  try {
    await current;
  } finally {
    if (atomicWriteQueues.get(filePath) === current) {
      atomicWriteQueues.delete(filePath);
    }
  }
}

function randomSuffix() {
  return crypto.randomUUID().replace(/-/g, '');
}
