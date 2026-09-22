import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

test('MCP resource_link can be materialized later through resources/read', async () => {
  const store = new FileTransferStore();
  const bytes = Buffer.alloc(3 * 1024 * 1024, 0x61);
  const runtime = {
    fileTransferStore: store,
    environmentRegistry: {
      defaultEnvironmentId: null,
      listPublic() { return []; },
    },
    async close() { store.close(); },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: 'emit_file_link',
    provider: 'test',
    provenance: 'test',
    surfaces: { direct: true },
    description: 'Return a temporary file resource link.',
    inputSchema: {},
    handler: async () => {
      const entry = store.put({
        path: 'report.docx',
        filename: 'report.docx',
        mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        byte_length: bytes.length,
        sha256: 'test-sha256',
        data: bytes.toString('base64'),
      }, { environmentId: 'test-worker' });
      return {
        content: [{
          type: 'resource_link',
          uri: entry.uri,
          name: entry.filename,
          mimeType: entry.mime_type,
          size: entry.byte_length,
        }],
      };
    },
  });

  const controller = createHttpController({
    toolRegistry: registry,
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
    const linked = await client.callTool({ name: 'emit_file_link', arguments: {} });
    const resourceLink = linked.content[0];
    assert.equal(resourceLink.type, 'resource_link');
    assert.equal(resourceLink.size, bytes.length);

    const read = await client.readResource({ uri: resourceLink.uri });
    assert.equal(read.contents.length, 1);
    assert.equal(read.contents[0].uri, resourceLink.uri);
    assert.equal(read.contents[0].mimeType, resourceLink.mimeType);
    assert.deepEqual(Buffer.from(read.contents[0].blob, 'base64'), bytes);
    assert.equal(read.contents[0]._meta.filename, 'report.docx');
  } finally {
    await client.close().catch(() => {});
    await controller.close();
  }
});
