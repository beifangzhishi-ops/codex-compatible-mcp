import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import {
  VIEW_IMAGE_LEGACY_UI_URI,
  VIEW_IMAGE_UI_HTML,
  VIEW_IMAGE_UI_URI,
  VIEW_IMAGE_V5_UI_URI,
  VIEW_IMAGE_V4_UI_URI,
  VIEW_IMAGE_V3_UI_URI,
  VIEW_IMAGE_V2_UI_URI,
} from '../src/ui/view-image-app.mjs';

function widgetScript() {
  const start = VIEW_IMAGE_UI_HTML.indexOf('<script>') + '<script>'.length;
  const end = VIEW_IMAGE_UI_HTML.indexOf('</script>', start);
  return VIEW_IMAGE_UI_HTML.slice(start, end);
}

test('view_image ChatGPT fallback uploads temporary file and stores imageIds', async () => {
  const listeners = new Map();
  const status = { textContent: '' };
  let widgetState = null;
  let uploadOptions = null;
  let uploadedFile = null;
  let followUp = null;
  let intrinsicHeight = null;
  let closeCount = 0;

  class FakeFile {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = options?.type || '';
    }
  }

  const parent = {
    postMessage(message) {
      if (message.method !== 'ui/initialize') return;
      queueMicrotask(() => {
        for (const listener of listeners.get('message') || []) {
          listener({
            source: parent,
            data: {
              jsonrpc: '2.0',
              id: message.id,
              result: { hostCapabilities: {} },
            },
          });
        }
      });
    },
  };

  const window = {
    parent,
    openai: {
      toolResponseMetadata: {
        mcp_tool_result: {
          content: [{
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgo=',
          }],
          _meta: { path: 'probe.png' },
        },
      },
      async uploadFile(file, options) {
        uploadedFile = file;
        uploadOptions = options;
        return { fileId: 'file_ccm_probe' };
      },
      setWidgetState(state) {
        widgetState = state;
      },
      async sendFollowUpMessage(message) {
        followUp = message;
      },
      notifyIntrinsicHeight(value) {
        intrinsicHeight = value;
      },
      async requestClose() {
        closeCount += 1;
      },
    },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
  };

  vm.runInNewContext(widgetScript(), {
    window,
    document: { getElementById: () => status },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Uint8Array,
    File: FakeFile,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  });

  for (let attempt = 0; attempt < 20 && !widgetState; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(uploadedFile);
  assert.equal(uploadedFile.name, 'probe.png');
  assert.equal(uploadedFile.type, 'image/png');
  assert.equal(uploadOptions.library, false);
  assert.equal(widgetState.imageIds.length, 1);
  assert.equal(widgetState.imageIds[0], 'file_ccm_probe');
  assert.equal(widgetState.privateContent.fileId, 'file_ccm_probe');
  assert.match(widgetState.modelContent, /Review the image/);
  assert.ok(followUp);
  assert.match(followUp.prompt, /Continue the current task using the image now/);
  assert.equal(intrinsicHeight.height, 0);
  assert.ok(closeCount >= 1);
});

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
    fileService: {
      async viewImage() {
        return {
          path: 'probe.png',
          mime_type: 'image/png',
          width: 1,
          height: 1,
          byte_length: 68,
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2F+QAAAAASUVORK5CYII=',
        };
      },
    },
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
    assert.equal(viewImage.outputSchema, undefined);

    const resource = await client.readResource({ uri: VIEW_IMAGE_UI_URI });
    assert.equal(resource.contents.length, 1);
    assert.equal(
      resource.contents[0].mimeType,
      'text/html;profile=mcp-app',
    );
    assert.equal(resource.contents[0].text, VIEW_IMAGE_UI_HTML);
    assert.equal(resource.contents[0]._meta.ui.prefersBorder, false);
    assert.match(resource.contents[0].text, /ui\/initialize/);
    assert.match(resource.contents[0].text, /ui\/update-model-context/);
    assert.match(resource.contents[0].text, /ui\/message/);
    assert.match(resource.contents[0].text, /toolResponseMetadata/);
    assert.match(resource.contents[0].text, /sendFollowUpMessage/);
    assert.match(resource.contents[0].text, /uploadFile/);
    assert.match(resource.contents[0].text, /setWidgetState/);
    assert.match(resource.contents[0].text, /imageIds/);
    assert.match(resource.contents[0].text, /library: false/);
    assert.match(resource.contents[0].text, /notifyIntrinsicHeight/);
    assert.match(resource.contents[0].text, /ui\/notifications\/size-changed/);
    assert.match(resource.contents[0].text, /requestClose/);
    assert.match(resource.contents[0].text, /openai:set_globals/);
    assert.match(resource.contents[0].text, /type: "image"/);
    assert.doesNotMatch(resource.contents[0].text, /<img\b/);
    assert.match(resource.contents[0].text, /#frame \{ display: none !important; \}/);

    const legacyResource = await client.readResource({
      uri: VIEW_IMAGE_LEGACY_UI_URI,
    });
    assert.equal(
      legacyResource.contents[0].mimeType,
      'text/html;profile=mcp-app',
    );
    assert.equal(legacyResource.contents[0].text, VIEW_IMAGE_UI_HTML);

    const v2Resource = await client.readResource({ uri: VIEW_IMAGE_V2_UI_URI });
    assert.equal(v2Resource.contents[0].text, VIEW_IMAGE_UI_HTML);

    const v3Resource = await client.readResource({ uri: VIEW_IMAGE_V3_UI_URI });
    assert.equal(v3Resource.contents[0].text, VIEW_IMAGE_UI_HTML);

    const v4Resource = await client.readResource({ uri: VIEW_IMAGE_V4_UI_URI });
    assert.equal(v4Resource.contents[0].text, VIEW_IMAGE_UI_HTML);

    const v5Resource = await client.readResource({ uri: VIEW_IMAGE_V5_UI_URI });
    assert.equal(v5Resource.contents[0].text, VIEW_IMAGE_UI_HTML);

    const imageResult = await client.callTool({
      name: 'view_image',
      arguments: { path: 'probe.png' },
    });
    assert.equal(imageResult.content[0].type, 'image');
    assert.equal(imageResult.structuredContent, undefined);
    assert.equal(imageResult._meta.path, 'probe.png');
  } finally {
    await client.close().catch(() => {});
    await controller.close();
  }
});
