import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireWorkerInstanceLock,
  writeJsonAtomic,
} from '../src/worker/worker-state.mjs';

test('worker instance lock rejects a second live process with the same identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-worker-lock-'));
  const first = await acquireWorkerInstanceLock({
    stateDir: root,
    identity: 'worker-a',
    pid: 111,
    isProcessAlive: async (pid) => pid === 111,
  });
  try {
    await assert.rejects(
      acquireWorkerInstanceLock({
        stateDir: root,
        identity: 'worker-a',
        pid: 222,
        isProcessAlive: async (pid) => pid === 111,
      }),
      (error) =>
        error?.code === 'worker_instance_already_running' &&
        error?.pid === 111,
    );
  } finally {
    await first.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('controller-owned worker may take over a live instance lock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-worker-takeover-'));
  const first = await acquireWorkerInstanceLock({
    stateDir: root,
    identity: 'worker-a',
    pid: 111,
    isProcessAlive: async () => true,
  });
  let second = null;
  try {
    second = await acquireWorkerInstanceLock({
      stateDir: root,
      identity: 'worker-a',
      pid: 222,
      isProcessAlive: async () => true,
      allowTakeover: true,
    });
    const lock = JSON.parse(await fs.readFile(second.lockPath, 'utf8'));
    assert.equal(lock.pid, 222);

    await first.release();
    const afterOldRelease = JSON.parse(await fs.readFile(second.lockPath, 'utf8'));
    assert.equal(afterOldRelease.pid, 222);
  } finally {
    await second?.release();
    await first.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('worker instance lock recovers a stale lock', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-worker-stale-'));
  const stalePath = path.join(root, 'ccm-worker-worker-a.lock');
  await fs.writeFile(stalePath, JSON.stringify({ pid: 999999 }) + '\n');
  const lock = await acquireWorkerInstanceLock({
    stateDir: root,
    identity: 'worker-a',
    pid: 333,
    isProcessAlive: async () => false,
  });
  try {
    const value = JSON.parse(await fs.readFile(lock.lockPath, 'utf8'));
    assert.equal(value.pid, 333);
  } finally {
    await lock.release();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writeJsonAtomic always leaves a complete JSON file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-health-atomic-'));
  const target = path.join(root, 'health.json');
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeJsonAtomic(target, { index, state: 'connected' }),
      ),
    );
    const value = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.equal(value.state, 'connected');
    assert.ok(Number.isInteger(value.index));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
