import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

test('MCP bridge resource bytes can be read through resources/read', async () => {
  const store = new FileTransferStore();
  const bytes = Buffer.alloc(3 * 1024 * 1024, 0x61);
  const entry = store.put({
    path: 'report.docx',
    filename: 'report.docx',
    mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byte_length: bytes.length,
    sha256: 'test-sha256',
    data: bytes.toString('base64'),
  }, { environmentId: 'test-worker' });
  const runtime = {
    fileTransferStore: store,
    environmentRegistry: {
      defaultEnvironmentId: null,
      listPublic() { return []; },
    },
    async close() { store.close(); },
  };
  const controller = createHttpController({
    toolRegistry: new ToolRegistry(),
    runtime,
    port: 0,
  });
  await controller.start();
  const client = new Client({ name: 'ccm-resource-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + controller.address.port + '/ccm/mcp'),
  );
  try {
    await client.connect(transport);
    const read = await client.readResource({ uri: entry.uri });
    assert.equal(read.contents.length, 1);
    assert.equal(read.contents[0].uri, entry.uri);
    assert.equal(read.contents[0].mimeType, entry.mime_type);
    assert.deepEqual(Buffer.from(read.contents[0].blob, 'base64'), bytes);
    assert.equal(read.contents[0]._meta.filename, 'report.docx');
  } finally {
    await client.close().catch(() => {});
    await controller.close();
  }
});

test('MCP bridge resource survives Controller recreation when the store is persisted', async () => {
  const root = path.resolve('.cache', 'test-file-transfer-resource');
  await fs.mkdir(root, { recursive: true });
  const stateDir = await fs.mkdtemp(path.join(root, 'restart-'));
  const bytes = Buffer.from('survives-controller-restart');
  let resourceUri;

  try {
    const firstStore = new FileTransferStore({ stateDir, ttlMs: 0 });
    const firstRuntime = {
      fileTransferStore: firstStore,
      environmentRegistry: {
        defaultEnvironmentId: null,
        listPublic() { return []; },
      },
      async close() { firstStore.close(); },
    };
    const entry = firstStore.put({
      path: 'restart.txt',
      filename: 'restart.txt',
      mime_type: 'text/plain',
      byte_length: bytes.length,
      sha256: 'restart-sha',
      data: bytes.toString('base64'),
    }, { environmentId: 'test-worker' });
    resourceUri = entry.uri;
    const firstController = createHttpController({
      toolRegistry: new ToolRegistry(),
      runtime: firstRuntime,
      port: 0,
    });
    await firstController.start();
    const firstClient = new Client({
      name: 'ccm-resource-restart-first',
      version: '0.1.0',
    });
    const firstTransport = new StreamableHTTPClientTransport(
      new URL(
        'http://127.0.0.1:' + firstController.address.port + '/ccm/mcp',
      ),
    );
    try {
      await firstClient.connect(firstTransport);
      const read = await firstClient.readResource({ uri: resourceUri });
      assert.deepEqual(Buffer.from(read.contents[0].blob, 'base64'), bytes);
    } finally {
      await firstClient.close().catch(() => {});
      await firstController.close();
    }

    const secondStore = new FileTransferStore({ stateDir, ttlMs: 0 });
    const secondRuntime = {
      fileTransferStore: secondStore,
      environmentRegistry: {
        defaultEnvironmentId: null,
        listPublic() { return []; },
      },
      async close() { secondStore.close(); },
    };
    const secondController = createHttpController({
      toolRegistry: new ToolRegistry(),
      runtime: secondRuntime,
      port: 0,
    });
    await secondController.start();
    const secondClient = new Client({
      name: 'ccm-resource-restart-second',
      version: '0.1.0',
    });
    const secondTransport = new StreamableHTTPClientTransport(
      new URL(
        'http://127.0.0.1:' + secondController.address.port + '/ccm/mcp',
      ),
    );
    try {
      await secondClient.connect(secondTransport);
      const read = await secondClient.readResource({ uri: resourceUri });
      assert.deepEqual(Buffer.from(read.contents[0].blob, 'base64'), bytes);
      assert.equal(read.contents[0]._meta.filename, 'restart.txt');
    } finally {
      await secondClient.close().catch(() => {});
      await secondController.close();
    }
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
