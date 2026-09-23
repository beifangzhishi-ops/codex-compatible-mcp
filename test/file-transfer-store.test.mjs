import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';

async function withStateDir(action) {
  const root = path.resolve('.cache', 'test-file-transfer-store');
  await fs.mkdir(root, { recursive: true });
  const stateDir = await fs.mkdtemp(path.join(root, 'case-'));
  try {
    return await action(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function encoded(value, name = 'report.txt') {
  const data = Buffer.from(value);
  return {
    path: name,
    filename: name,
    mime_type: 'text/plain',
    byte_length: data.length,
    sha256: 'sha-' + value,
    data: data.toString('base64'),
  };
}

test('FileTransferStore survives Controller-style close and recreation', async () => {
  await withStateDir(async (stateDir) => {
    const first = new FileTransferStore({
      stateDir,
      ttlMs: 0,
      maxTotalBytes: 1024,
    });
    const created = first.put(encoded('persistent'), {
      environmentId: 'worker-a',
    });
    first.close();

    const second = new FileTransferStore({
      stateDir,
      ttlMs: 0,
      maxTotalBytes: 1024,
    });
    const restored = second.get(created.token);
    assert.ok(restored);
    assert.equal(restored.uri, created.uri);
    assert.equal(restored.environment_id, 'worker-a');
    assert.equal(
      Buffer.from(restored.data, 'base64').toString(),
      'persistent',
    );
    second.close();
  });
});

test('FileTransferStore only expires entries when an explicit positive TTL is set', async () => {
  await withStateDir(async (stateDir) => {
    let now = 1_000;
    const first = new FileTransferStore({
      stateDir,
      ttlMs: 100,
      maxTotalBytes: 1024,
      clock: () => now,
    });
    const created = first.put(encoded('ttl'));
    assert.ok(first.get(created.token));
    first.close();

    now = 1_101;
    const second = new FileTransferStore({
      stateDir,
      ttlMs: 100,
      maxTotalBytes: 1024,
      clock: () => now,
    });
    assert.equal(second.get(created.token), null);
    const files = await fs.readdir(stateDir);
    assert.deepEqual(files, []);
    second.close();
  });
});

test('FileTransferStore persists bounded oldest-first eviction across recreation', async () => {
  await withStateDir(async (stateDir) => {
    let now = 1_000;
    const first = new FileTransferStore({
      stateDir,
      ttlMs: 0,
      maxTotalBytes: 8,
      clock: () => now,
    });
    const oldest = first.put(encoded('12345', 'old.txt'));
    now += 1;
    const newest = first.put(encoded('6789', 'new.txt'));
    assert.equal(first.get(oldest.token), null);
    assert.ok(first.get(newest.token));
    first.close();

    const second = new FileTransferStore({
      stateDir,
      ttlMs: 0,
      maxTotalBytes: 8,
      clock: () => now,
    });
    assert.equal(second.get(oldest.token), null);
    assert.ok(second.get(newest.token));
    second.close();
  });
});
