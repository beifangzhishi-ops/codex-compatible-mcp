import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

async function withController(fn) {
  const base = path.resolve('.cache', 'test-http-file-download');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'case-'));
  const store = new FileTransferStore({ stateDir: dir });
  const controller = createHttpController({ runtime: {
    fileTransferStore: store,
    environmentRegistry: { defaultEnvironmentId: null, listPublic() { return []; } },
    async close() { store.close(); },
  }, toolRegistry: new ToolRegistry(), port: 0 });
  try { await controller.start(); await fn({ store, origin: 'http://127.0.0.1:' + controller.address.port }); }
  finally { await controller.close(); await fs.rm(dir, { recursive: true, force: true }); }
}
function put(store, bytes, mime = 'text/plain') {
  return store.put({ filename: '中文"\nfile.txt', mime_type: mime, byte_length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') });
}
test('Controller streams original file bytes and safe attachment headers', async () => withController(async ({ store, origin }) => {
  const bytes = Buffer.alloc(3 * 1024 * 1024, 0x61);
  const entry = put(store, bytes);
  const uri = origin + '/ccm/download/' + entry.token;
  for (let i = 0; i < 2; i++) {
    const res = await fetch(uri);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), String(bytes.length));
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  }
  assert.equal((await fetch(uri, { method: 'POST' })).status, 405);
  assert.equal((await fetch(uri + '?leak=1')).status, 404);
  assert.equal((await fetch(origin + '/ccm/download/not-a-token')).status, 404);
  assert.equal((await fetch(origin + '/ccm/preview/' + entry.token)).status, 404);
}));
test('Controller serves inline only allowlisted PNG/JPEG/WebP image types', async () => withController(async ({ store, origin }) => {
  const entry = put(store, Buffer.from('fake-png'), 'image/png');
  const res = await fetch(origin + '/ccm/preview/' + entry.token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-disposition'), 'inline');
  assert.equal(await res.text(), 'fake-png');
}));
