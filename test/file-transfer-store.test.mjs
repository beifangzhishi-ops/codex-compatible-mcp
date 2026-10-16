import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileTransferStore, FILE_TTL_MS } from '../src/controller/file-transfer-store.mjs';

async function withDir(fn) {
  const base = path.resolve('.cache', 'test-file-transfer-store');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'case-'));
  try { await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function encoded(text) {
  const buffer = Buffer.from(text);
  return { filename: '中文"\nreport.txt', mime_type: 'text/plain', byte_length: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'), data: buffer.toString('base64') };
}
test('FileTransferStore persists raw bytes on disk but only indexes metadata', async () => withDir(async (dir) => {
  const first = new FileTransferStore({ stateDir: dir, maxTotalBytes: 1024 });
  const entry = first.put(encoded('persistent'), { environmentId: 'worker-a' });
  assert.equal(entry.data, undefined);
  assert.equal(entry.expiresAt - entry.createdAt, FILE_TTL_MS);
  assert.equal((await fs.readFile(path.join(dir, entry.token + '.bin'))).toString(), 'persistent');
  const meta = JSON.parse(await fs.readFile(path.join(dir, entry.token + '.json'), 'utf8'));
  assert.equal(Object.hasOwn(meta, 'data'), false);
  first.close();
  const second = new FileTransferStore({ stateDir: dir, maxTotalBytes: 1024 });
  assert.equal(second.get(entry.token).environment_id, 'worker-a');
  second.close();
}));
test('Fixed TTL is 72 hours, never extended by restart or GET', async () => withDir(async (dir) => {
  let now = 1_000;
  const first = new FileTransferStore({ stateDir: dir, clock: () => now });
  const entry = first.put(encoded('ttl'));
  now = entry.expiresAt - 1;
  assert.ok(first.get(entry.token));
  first.close();
  const second = new FileTransferStore({ stateDir: dir, clock: () => now });
  assert.equal(second.get(entry.token).expiresAt, entry.expiresAt);
  now++;
  assert.equal(second.get(entry.token), null);
  assert.deepEqual(await fs.readdir(dir), []);
  second.close();
}));
test('Oldest-first bounded eviction and persisted recovery', async () => withDir(async (dir) => {
  let now = 1000;
  const store = new FileTransferStore({ stateDir: dir, maxTotalBytes: 8, clock: () => now });
  const old = store.put(encoded('12345'));
  now++;
  const latest = store.put(encoded('6789'));
  assert.equal(store.get(old.token), null);
  assert.ok(store.get(latest.token));
  store.close();
  const restored = new FileTransferStore({ stateDir: dir, maxTotalBytes: 8, clock: () => now });
  assert.ok(restored.get(latest.token));
  restored.close();
}));
test('Rejects altered hash and discards legacy base64 records', async () => withDir(async (dir) => {
  const store = new FileTransferStore({ stateDir: dir });
  assert.throws(() => store.put({ ...encoded('safe'), sha256: 'a'.repeat(64) }), /checksum/i);
  const e = store.put(encoded('safe'));
  store.close();
  const metaFile = path.join(dir, e.token + '.json');
  const old = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  delete old.expiresAt;
  old.data = 'YXg=';
  await fs.writeFile(metaFile, JSON.stringify(old));
  const next = new FileTransferStore({ stateDir: dir });
  assert.equal(next.get(e.token), null);
  assert.deepEqual(await fs.readdir(dir), []);
  next.close();
}));
test('Active download keeps its file handle while capacity eviction invalidates token', async () => withDir(async (dir) => {
  const store = new FileTransferStore({ stateDir: dir, maxTotalBytes: 6 });
  const old = store.put(encoded('1234'));
  const download = store.acquire(old.token);
  assert.ok(download);
  const streamed = new Promise((resolve, reject) => {
    const chunks = [];
    download.stream.on('data', (chunk) => chunks.push(chunk));
    download.stream.on('close', () => resolve(Buffer.concat(chunks).toString()));
    download.stream.on('error', reject);
    download.stream.on('close', download.release);
  });
  store.put(encoded('5678'));
  assert.equal(store.get(old.token), null);
  assert.equal(await streamed, '1234');
  assert.equal((await fs.readdir(dir)).some((name) => name === old.token + '.bin'), false);
  store.close();
}));
test('Failed publish does not evict an existing valid file', async () => withDir(async (dir) => {
  const store = new FileTransferStore({ stateDir: dir, maxTotalBytes: 4 });
  const existing = store.put(encoded('1234'));
  assert.throws(() => store.put(encoded('too-large')), /limit/i);
  assert.ok(store.get(existing.token));
  store.close();
}));
