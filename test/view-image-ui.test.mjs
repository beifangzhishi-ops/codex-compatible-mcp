import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import {
  VIEW_IMAGE_UI_HTML,
  VIEW_IMAGE_UI_URI,
} from '../src/ui/view-image-app.mjs';

test('view_image exposes an MCP Apps image-context bridge', async () => {
  const environmentRegistry = {
    defaultEnvironmentId: null,
    listPublic() {
      return [];
    },
  };
  const fileTransferStore = new FileTransferStore();
  const runtime = {
    environmentRegistry,
    fileTransferStore,
    async close() {
      fileTransferStore.close();
    },
  };
  const registry = registerCoreTools(new ToolRegistry(), runtime);
  const controller = createHttpController({
    toolRegistry: registry,
    runtime,
    port: 0,
  });
  await controller.start();

  const client = new Client({
    name: 'ccm-view-image-ui-test',
    version: '0.1.0',
  });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + controller.address.port + '/ccm/mcp'),
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const viewImage = listed.tools.find((tool) => tool.name === 'view_image');
    assert.ok(viewImage);
    assert.deepEqual(viewImage.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    assert.equal(viewImage._meta.ui.resourceUri, VIEW_IMAGE_UI_URI);
    assert.equal(viewImage._meta['ui/resourceUri'], VIEW_IMAGE_UI_URI);
    assert.equal(
      viewImage._meta['openai/outputTemplate'],
      VIEW_IMAGE_UI_URI,
    );
    assert.ok(viewImage.outputSchema);

    const resource = await client.readResource({ uri: VIEW_IMAGE_UI_URI });
    assert.equal(resource.contents.length, 1);
    assert.equal(
      resource.contents[0].mimeType,
      'text/html;profile=mcp-app',
    );
    assert.equal(resource.contents[0].text, VIEW_IMAGE_UI_HTML);
    assert.match(resource.contents[0].text, /ui\/initialize/);
    assert.match(resource.contents[0].text, /ui\/update-model-context/);
    assert.match(resource.contents[0].text, /type: "image"/);
    assert.doesNotMatch(resource.contents[0].text, /uploadFile/);
  } finally {
    await client.close().catch(() => {});
    await controller.close();
  }
});
