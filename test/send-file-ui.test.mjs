import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FileTransferStore } from '../src/controller/file-transfer-store.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { registerSpecializedTools } from '../src/tools/specialized-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import {
  SEND_FILE_UI_HTML,
  SEND_FILE_UI_URI,
} from '../src/ui/send-file-app.mjs';

function widgetScript() {
  const start = SEND_FILE_UI_HTML.indexOf('<script>') + '<script>'.length;
  const end = SEND_FILE_UI_HTML.indexOf('</script>', start);
  return SEND_FILE_UI_HTML.slice(start, end);
}

function fakeElement() {
  const listeners = new Map();
  return {
    textContent: '',
    disabled: false,
    dataset: {},
    style: {},
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    async click() {
      for (const listener of listeners.get('click') || []) {
        await listener();
      }
    },
  };
}

function toolResult() {
  return {
    content: [{
      type: 'resource_link',
      uri: 'ccm-file:///00000000-0000-4000-8000-000000000123',
      name: 'deck.zip',
      mimeType: 'application/zip',
      size: 4,
    }],
    structuredContent: {
      capability: 'send_file',
      filename: 'deck.zip',
      mime_type: 'application/zip',
      byte_length: 4,
      sha256: 'sha-test',
    },
  };
}

test('send_file widget materializes MCP resource into a non-Library ChatGPT file', async () => {
  const listeners = new Map();
  const elements = new Map([
    ['file-name', fakeElement()],
    ['file-meta', fakeElement()],
    ['status', fakeElement()],
    ['download', fakeElement()],
    ['icon', fakeElement()],
  ]);
  let readCount = 0;
  let uploadCount = 0;
  let uploadOptions = null;
  let uploadedFile = null;
  let widgetState = null;
  let downloadFileId = null;
  let clickedAnchor = null;

  class FakeFile {
    constructor(parts, name, options) {
      this.parts = parts;
      this.name = name;
      this.type = options?.type || '';
    }
  }

  const parent = {
    postMessage(message) {
      if (!Object.hasOwn(message, 'id')) return;
      let result = {};
      if (message.method === 'ui/initialize') {
        result = { hostCapabilities: {} };
      } else if (message.method === 'resources/read') {
        readCount += 1;
        result = {
          contents: [{
            uri: message.params.uri,
            mimeType: 'application/zip',
            blob: Buffer.from('test').toString('base64'),
          }],
        };
      } else {
        return;
      }
      queueMicrotask(() => {
        for (const listener of listeners.get('message') || []) {
          listener({
            source: parent,
            data: { jsonrpc: '2.0', id: message.id, result },
          });
        }
      });
    },
  };

  const window = {
    parent,
    openai: {
      widgetState: null,
      toolResponseMetadata: { mcp_tool_result: toolResult() },
      async uploadFile(file, options) {
        uploadCount += 1;
        uploadedFile = file;
        uploadOptions = options;
        return { fileId: 'file_ccm_deck' };
      },
      setWidgetState(state) {
        widgetState = state;
        this.widgetState = state;
      },
      async getFileDownloadUrl({ fileId }) {
        downloadFileId = fileId;
        return { downloadUrl: 'https://files.example.test/fresh' };
      },
      notifyIntrinsicHeight() {},
    },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
  };

  const body = {
    appendChild(anchor) {
      clickedAnchor = anchor;
    },
  };
  const document = {
    body,
    getElementById(id) {
      return elements.get(id);
    },
    createElement(name) {
      assert.equal(name, 'a');
      return {
        href: '',
        download: '',
        rel: '',
        style: {},
        click() {
          this.clicked = true;
        },
        remove() {},
      };
    },
  };

  vm.runInNewContext(widgetScript(), {
    window,
    document,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Uint8Array,
    File: FakeFile,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Number,
    String,
    Object,
    Map,
    Promise,
    Error,
  });

  for (let attempt = 0; attempt < 40 && !widgetState; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.equal(readCount, 1);
  assert.ok(uploadedFile);
  assert.equal(uploadedFile.name, 'deck.zip');
  assert.equal(uploadedFile.type, 'application/zip');
  assert.equal(uploadOptions.library, false);
  assert.equal(widgetState.privateContent.fileId, 'file_ccm_deck');
  assert.equal(widgetState.privateContent.filename, 'deck.zip');
  assert.equal(widgetState.privateContent.sha256, 'sha-test');
  assert.equal(
    widgetState.privateContent.resourceUri,
    'ccm-file:///00000000-0000-4000-8000-000000000123',
  );
  assert.equal(elements.get('download').disabled, false);
  assert.equal(elements.get('file-name').textContent, 'deck.zip');

  for (const listener of listeners.get('message') || []) {
    listener({
      source: parent,
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: toolResult(),
      },
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(readCount, 1);
  assert.equal(uploadCount, 1);

  await elements.get('download').click();
  for (let attempt = 0; attempt < 20 && !clickedAnchor; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(downloadFileId, 'file_ccm_deck');
  assert.equal(clickedAnchor.href, 'https://files.example.test/fresh');
  assert.equal(clickedAnchor.download, 'deck.zip');
  assert.equal(clickedAnchor.clicked, true);
});

test('send_file widget reuses persisted fileId without re-uploading', async () => {
  const listeners = new Map();
  const elements = new Map([
    ['file-name', fakeElement()],
    ['file-meta', fakeElement()],
    ['status', fakeElement()],
    ['download', fakeElement()],
    ['icon', fakeElement()],
  ]);
  let readCount = 0;
  let uploadCount = 0;
  let widgetState = null;

  const persisted = {
    privateContent: {
      source: 'ccm.send_file',
      fileId: 'file_existing',
      filename: 'deck.zip',
      mimeType: 'application/zip',
      size: 4,
      sha256: 'sha-test',
    },
  };
  const parent = {
    postMessage(message) {
      if (!Object.hasOwn(message, 'id')) return;
      if (message.method === 'resources/read') readCount += 1;
      queueMicrotask(() => {
        for (const listener of listeners.get('message') || []) {
          listener({
            source: parent,
            data: {
              jsonrpc: '2.0',
              id: message.id,
              result: message.method === 'ui/initialize'
                ? { hostCapabilities: {} }
                : {},
            },
          });
        }
      });
    },
  };
  const window = {
    parent,
    openai: {
      widgetState: persisted,
      toolResponseMetadata: { mcp_tool_result: toolResult() },
      async uploadFile() {
        uploadCount += 1;
        return { fileId: 'unexpected' };
      },
      setWidgetState(state) {
        widgetState = state;
        this.widgetState = state;
      },
      notifyIntrinsicHeight() {},
    },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
  };
  const document = {
    body: { appendChild() {} },
    getElementById(id) {
      return elements.get(id);
    },
    createElement() {
      return { style: {}, click() {}, remove() {} };
    },
  };

  vm.runInNewContext(widgetScript(), {
    window,
    document,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Uint8Array,
    File: class {},
    atob: () => '',
    Number,
    String,
    Object,
    Map,
    Promise,
    Error,
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(readCount, 0);
  assert.equal(uploadCount, 0);
  assert.equal(elements.get('download').disabled, false);
  assert.equal(elements.get('file-name').textContent, 'deck.zip');
  assert.equal(widgetState.privateContent.fileId, 'file_existing');
  assert.equal(
    widgetState.privateContent.resourceUri,
    'ccm-file:///00000000-0000-4000-8000-000000000123',
  );
});

test('send_file widget rematerializes the MCP resource when a saved fileId is stale', async () => {
  const listeners = new Map();
  const elements = new Map([
    ['file-name', fakeElement()],
    ['file-meta', fakeElement()],
    ['status', fakeElement()],
    ['download', fakeElement()],
    ['icon', fakeElement()],
  ]);
  let readCount = 0;
  let uploadCount = 0;
  let widgetState = null;
  let clickedAnchor = null;

  const parent = {
    postMessage(message) {
      if (!Object.hasOwn(message, 'id')) return;
      let result = {};
      if (message.method === 'ui/initialize') {
        result = { hostCapabilities: {} };
      } else if (message.method === 'resources/read') {
        readCount += 1;
        result = {
          contents: [{
            uri: message.params.uri,
            mimeType: 'application/zip',
            blob: Buffer.from('test').toString('base64'),
          }],
        };
      }
      queueMicrotask(() => {
        for (const listener of listeners.get('message') || []) {
          listener({
            source: parent,
            data: { jsonrpc: '2.0', id: message.id, result },
          });
        }
      });
    },
  };
  const window = {
    parent,
    openai: {
      widgetState: {
        privateContent: {
          source: 'ccm.send_file',
          fileId: 'file_stale',
          filename: 'deck.zip',
          mimeType: 'application/zip',
          size: 4,
          sha256: 'sha-test',
        },
      },
      toolResponseMetadata: { mcp_tool_result: toolResult() },
      async uploadFile() {
        uploadCount += 1;
        return { fileId: 'file_recovered' };
      },
      setWidgetState(state) {
        widgetState = state;
        this.widgetState = state;
      },
      async getFileDownloadUrl({ fileId }) {
        if (fileId === 'file_stale') throw new Error('saved file expired');
        assert.equal(fileId, 'file_recovered');
        return { downloadUrl: 'https://files.example.test/recovered' };
      },
      notifyIntrinsicHeight() {},
    },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
  };
  const document = {
    body: {
      appendChild(anchor) {
        clickedAnchor = anchor;
      },
    },
    getElementById(id) {
      return elements.get(id);
    },
    createElement() {
      return {
        href: '',
        download: '',
        rel: '',
        style: {},
        click() { this.clicked = true; },
        remove() {},
      };
    },
  };

  vm.runInNewContext(widgetScript(), {
    window,
    document,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Uint8Array,
    File: class {},
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Number,
    String,
    Object,
    Map,
    Promise,
    Error,
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(readCount, 0);
  assert.equal(uploadCount, 0);

  await elements.get('download').click();
  for (let attempt = 0; attempt < 30 && !clickedAnchor; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(readCount, 1);
  assert.equal(uploadCount, 1);
  assert.equal(widgetState.privateContent.fileId, 'file_recovered');
  assert.equal(clickedAnchor.href, 'https://files.example.test/recovered');
  assert.equal(clickedAnchor.clicked, true);
  assert.equal(elements.get('status').textContent, 'Ready');
});

test('send_file widget recovers a stale fileId after reload without the tool result', async () => {
  const listeners = new Map();
  const elements = new Map([
    ['file-name', fakeElement()],
    ['file-meta', fakeElement()],
    ['status', fakeElement()],
    ['download', fakeElement()],
    ['icon', fakeElement()],
  ]);
  let readCount = 0;
  let uploadCount = 0;
  let widgetState = null;
  let clickedAnchor = null;
  const resourceUri = 'ccm-file:///00000000-0000-4000-8000-000000000123';

  const parent = {
    postMessage(message) {
      if (!Object.hasOwn(message, 'id')) return;
      let result = {};
      if (message.method === 'ui/initialize') {
        result = { hostCapabilities: {} };
      } else if (message.method === 'resources/read') {
        readCount += 1;
        assert.equal(message.params.uri, resourceUri);
        result = {
          contents: [{
            uri: resourceUri,
            mimeType: 'application/zip',
            blob: Buffer.from('test').toString('base64'),
          }],
        };
      }
      queueMicrotask(() => {
        for (const listener of listeners.get('message') || []) {
          listener({
            source: parent,
            data: { jsonrpc: '2.0', id: message.id, result },
          });
        }
      });
    },
  };
  const window = {
    parent,
    openai: {
      widgetState: {
        privateContent: {
          source: 'ccm.send_file',
          fileId: 'file_stale_after_reload',
          filename: 'deck.zip',
          mimeType: 'application/zip',
          size: 4,
          sha256: 'sha-test',
          resourceUri,
        },
      },
      async uploadFile() {
        uploadCount += 1;
        return { fileId: 'file_reloaded_recovery' };
      },
      setWidgetState(state) {
        widgetState = state;
        this.widgetState = state;
      },
      async getFileDownloadUrl({ fileId }) {
        if (fileId === 'file_stale_after_reload') {
          throw new Error('saved file expired');
        }
        assert.equal(fileId, 'file_reloaded_recovery');
        return { downloadUrl: 'https://files.example.test/reloaded-recovery' };
      },
      notifyIntrinsicHeight() {},
    },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
  };
  const document = {
    body: {
      appendChild(anchor) {
        clickedAnchor = anchor;
      },
    },
    getElementById(id) {
      return elements.get(id);
    },
    createElement() {
      return {
        href: '',
        download: '',
        rel: '',
        style: {},
        click() { this.clicked = true; },
        remove() {},
      };
    },
  };

  vm.runInNewContext(widgetScript(), {
    window,
    document,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Uint8Array,
    File: class {},
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Number,
    String,
    Object,
    Map,
    Promise,
    Error,
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(readCount, 0);
  assert.equal(uploadCount, 0);

  await elements.get('download').click();
  for (let attempt = 0; attempt < 30 && !clickedAnchor; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(readCount, 1);
  assert.equal(uploadCount, 1);
  assert.equal(widgetState.privateContent.fileId, 'file_reloaded_recovery');
  assert.equal(widgetState.privateContent.resourceUri, resourceUri);
  assert.equal(widgetState.privateContent.sha256, 'sha-test');
  assert.equal(clickedAnchor.href, 'https://files.example.test/reloaded-recovery');
  assert.equal(clickedAnchor.clicked, true);
  assert.equal(elements.get('status').textContent, 'Ready');
});

test('send_file widget reports when stale reload recovery resource is unavailable', async () => {
  const listeners = new Map();
  const elements = new Map([
    ['file-name', fakeElement()],
    ['file-meta', fakeElement()],
    ['status', fakeElement()],
    ['download', fakeElement()],
    ['icon', fakeElement()],
  ]);
  let readCount = 0;
  let uploadCount = 0;
  const resourceUri = 'ccm-file:///00000000-0000-4000-8000-000000000123';

  const parent = {
    postMessage(message) {
      if (!Object.hasOwn(message, 'id')) return;
      queueMicrotask(() => {
        for (const listener of listeners.get('message') || []) {
          const data = message.method === 'resources/read'
            ? {
                jsonrpc: '2.0',
                id: message.id,
                error: {
                  code: -32000,
                  message: 'CCM file resource is unknown or expired',
                },
              }
            : {
                jsonrpc: '2.0',
                id: message.id,
                result: { hostCapabilities: {} },
              };
          if (message.method === 'resources/read') readCount += 1;
          listener({ source: parent, data });
        }
      });
    },
  };
  const window = {
    parent,
    openai: {
      widgetState: {
        privateContent: {
          source: 'ccm.send_file',
          fileId: 'file_stale_after_reload',
          filename: 'deck.zip',
          mimeType: 'application/zip',
          size: 4,
          sha256: 'sha-test',
          resourceUri,
        },
      },
      async uploadFile() {
        uploadCount += 1;
        return { fileId: 'unexpected' };
      },
      setWidgetState() {},
      async getFileDownloadUrl() {
        throw new Error('saved file expired');
      },
      notifyIntrinsicHeight() {},
    },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
  };
  const document = {
    body: { appendChild() {} },
    getElementById(id) {
      return elements.get(id);
    },
    createElement() {
      return { style: {}, click() {}, remove() {} };
    },
  };

  vm.runInNewContext(widgetScript(), {
    window,
    document,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Uint8Array,
    File: class {},
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    Number,
    String,
    Object,
    Map,
    Promise,
    Error,
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  await elements.get('download').click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(readCount, 1);
  assert.equal(uploadCount, 0);
  assert.match(
    elements.get('status').textContent,
    /Saved ChatGPT file expired and the CCM recovery resource could not be read/,
  );
  assert.match(
    elements.get('status').textContent,
    /CCM file resource is unknown or expired/,
  );
});

test('send_file UI uses a versioned MCP Apps resource URI', () => {
  assert.equal(SEND_FILE_UI_URI, 'ui://ccm/send-file-v1.html');
  assert.match(SEND_FILE_UI_HTML, /resources\/read/);
  assert.match(SEND_FILE_UI_HTML, /uploadFile/);
  assert.match(SEND_FILE_UI_HTML, /library: false/);
  assert.match(SEND_FILE_UI_HTML, /getFileDownloadUrl/);
  assert.match(SEND_FILE_UI_HTML, /widgetState/);
  assert.match(SEND_FILE_UI_HTML, /setWidgetState/);
  assert.match(SEND_FILE_UI_HTML, /ui\/notifications\/tool-result/);
});

test('send_file advertises its MCP App through tools/list', async () => {
  const fileTransferStore = new FileTransferStore();
  const runtime = {
    fileTransferStore,
    environmentRegistry: {
      defaultEnvironmentId: 'test-worker',
      listPublic() { return []; },
      resolve() {
        return {
          id: 'test-worker',
          platform: 'windows',
          capabilities: { sendFile: true },
        };
      },
    },
    workspaceContextManager: {
      resolve() {
        return {
          environment_id: 'test-worker',
          workspace_root: 'C:\\test',
        };
      },
    },
    fileService: {
      async sendFile() {
        return {
          environment_id: 'test-worker',
          path: 'C:\\test\\deck.zip',
          filename: 'deck.zip',
          mime_type: 'application/zip',
          byte_length: 4,
          sha256: 'sha-test',
          data: Buffer.from('test').toString('base64'),
        };
      },
    },
    async close() {
      fileTransferStore.close();
    },
  };
  const registry = new ToolRegistry();
  registerSpecializedTools(registry, runtime);
  const controller = createHttpController({
    toolRegistry: registry,
    runtime,
    port: 0,
  });
  await controller.start();
  const client = new Client({
    name: 'ccm-send-file-ui-test',
    version: '0.1.0',
  });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + controller.address.port + '/ccm/mcp'),
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const sendFile = listed.tools.find((tool) => tool.name === 'send_file');
    assert.ok(sendFile);
    assert.equal(sendFile._meta.ui.resourceUri, SEND_FILE_UI_URI);
    assert.equal(sendFile._meta['ui/resourceUri'], SEND_FILE_UI_URI);
    assert.equal(sendFile._meta['openai/outputTemplate'], SEND_FILE_UI_URI);

    const resource = await client.readResource({ uri: SEND_FILE_UI_URI });
    assert.equal(resource.contents[0].text, SEND_FILE_UI_HTML);
    assert.equal(resource.contents[0]._meta.ui.prefersBorder, true);
  } finally {
    await client.close().catch(() => {});
    await controller.close();
  }
});
