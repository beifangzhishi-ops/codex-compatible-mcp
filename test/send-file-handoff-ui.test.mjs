import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  SEND_FILE_HANDOFF_UI_HTML,
  SEND_FILE_HANDOFF_UI_URI,
} from '../src/ui/send-file-handoff-app.mjs';

function appScript() {
  const start = SEND_FILE_HANDOFF_UI_HTML.indexOf('<script>') +
    '<script>'.length;
  const end = SEND_FILE_HANDOFF_UI_HTML.indexOf('</script>', start);
  return SEND_FILE_HANDOFF_UI_HTML.slice(start, end);
}

function toolOutput(overrides = {}) {
  return {
    capability: 'send_file',
    environment_id: 'worker-a',
    path: 'C:\\docs\\deck.zip',
    filename: 'deck.zip',
    mime_type: 'application/zip',
    byte_length: 4,
    sha256: 'sha-test',
    resource_uri: 'ccm-file:///00000000-0000-4000-8000-000000000123',
    ...overrides,
  };
}

async function waitFor(predicate, message = 'condition') {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for ' + message);
}

function createHarness({
  output = toolOutput(),
  widgetState = null,
  readContent = {},
  upload = async () => ({ fileId: 'file_ccm_deck' }),
  requestClose = async () => {},
  includeUpload = true,
  includeRequestClose = true,
} = {}) {
  const listeners = new Map();
  let readCount = 0;
  let uploadCount = 0;
  let closeCount = 0;
  let heightCount = 0;
  let uploadedFile = null;
  let uploadOptions = null;
  let savedState = null;
  const errorBox = { hidden: true, textContent: '' };
  const body = { dataset: {} };

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
      let result;
      if (message.method === 'ui/initialize') {
        result = { hostCapabilities: {} };
      } else if (message.method === 'resources/read') {
        readCount += 1;
        result = {
          contents: [{
            uri: message.params.uri,
            mimeType: 'application/zip',
            blob: Buffer.from('test').toString('base64'),
            _meta: {
              filename: 'deck.zip',
              sha256: 'sha-test',
            },
            ...readContent,
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

  const openai = {
    widgetState,
    toolOutput: output,
    setWidgetState(state) {
      savedState = state;
    },
    notifyIntrinsicHeight() {
      heightCount += 1;
    },
  };
  if (includeUpload) {
    openai.uploadFile = async (file, options) => {
      uploadCount += 1;
      uploadedFile = file;
      uploadOptions = options;
      return upload(file, options);
    };
  }
  if (includeRequestClose) {
    openai.requestClose = async () => {
      closeCount += 1;
      return requestClose();
    };
  }

  const window = {
    parent,
    openai,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
  };
  const document = {
    body,
    getElementById(id) {
      assert.equal(id, 'error');
      return errorBox;
    },
  };

  vm.runInNewContext(appScript(), {
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

  return {
    window,
    errorBox,
    body,
    get readCount() { return readCount; },
    get uploadCount() { return uploadCount; },
    get closeCount() { return closeCount; },
    get heightCount() { return heightCount; },
    get uploadedFile() { return uploadedFile; },
    get uploadOptions() { return uploadOptions; },
    get savedState() { return savedState; },
    emitToolResult(value) {
      for (const listener of listeners.get('message') || []) {
        listener({
          source: parent,
          data: {
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: { structuredContent: value },
          },
        });
      }
    },
    emitGlobals() {
      for (const listener of listeners.get('openai:set_globals') || []) {
        listener({});
      }
    },
  };
}

test('send_file handoff uploads once with library=false and closes the widget', async () => {
  const harness = createHarness();
  await waitFor(() => harness.closeCount === 1, 'widget close');
  assert.equal(harness.readCount, 1);
  assert.equal(harness.uploadCount, 1);
  assert.equal(harness.uploadedFile.name, 'deck.zip');
  assert.equal(harness.uploadedFile.type, 'application/zip');
  assert.equal(harness.uploadOptions.library, false);
  assert.equal(harness.errorBox.hidden, true);
  assert.equal(harness.body.dataset.error, 'false');
  assert.equal(harness.savedState.privateContent.source, 'ccm.send_file');
  assert.equal(harness.savedState.privateContent.fileId, 'file_ccm_deck');
  assert.equal(
    harness.savedState.privateContent.resourceKey,
    toolOutput().resource_uri + '|sha-test',
  );
});

test('send_file handoff suppresses replay while widgetState reflection is delayed', async () => {
  let releaseUpload;
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  const harness = createHarness({
    upload: async () => {
      await uploadGate;
      return { fileId: 'file_delayed' };
    },
  });
  await waitFor(() => harness.uploadCount === 1, 'first upload');
  harness.emitToolResult(toolOutput());
  harness.emitGlobals();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.readCount, 1);
  assert.equal(harness.uploadCount, 1);
  releaseUpload();
  await waitFor(() => harness.closeCount === 1, 'close after delayed upload');
  harness.emitToolResult(toolOutput());
  harness.emitGlobals();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.readCount, 1);
  assert.equal(harness.uploadCount, 1);
});

test('send_file handoff reuses matching widgetState without reading or uploading', async () => {
  const output = toolOutput();
  const harness = createHarness({
    output,
    widgetState: {
      privateContent: {
        source: 'ccm.send_file',
        resourceKey: output.resource_uri + '|' + output.sha256,
        fileId: 'file_existing',
      },
    },
  });
  await waitFor(() => harness.closeCount === 1, 'close from restored state');
  assert.equal(harness.readCount, 0);
  assert.equal(harness.uploadCount, 0);
});

test('send_file handoff treats a new bridge URI as a new explicit transfer', async () => {
  const harness = createHarness();
  await waitFor(() => harness.closeCount === 1, 'first close');
  harness.emitToolResult(toolOutput({
    resource_uri: 'ccm-file:///00000000-0000-4000-8000-000000000456',
  }));
  await waitFor(() => harness.uploadCount === 2, 'second explicit upload');
  await waitFor(() => harness.closeCount === 2, 'second close');
  assert.equal(harness.readCount, 2);
});

test('send_file handoff rejects bridge metadata mismatches before upload', async () => {
  const harness = createHarness({
    readContent: {
      _meta: { filename: 'wrong.zip', sha256: 'sha-test' },
    },
  });
  await waitFor(() => harness.errorBox.hidden === false, 'metadata error');
  assert.equal(harness.uploadCount, 0);
  assert.equal(harness.closeCount, 0);
  assert.match(harness.errorBox.textContent, /name does not match/i);
});

for (const [label, readContent, pattern] of [
  [
    'SHA-256',
    { _meta: { filename: 'deck.zip', sha256: 'different-sha' } },
    /SHA-256 does not match/i,
  ],
  [
    'MIME type',
    { mimeType: 'application/octet-stream' },
    /MIME type does not match/i,
  ],
  [
    'byte length',
    { blob: Buffer.from('wrong-size').toString('base64') },
    /size changed/i,
  ],
]) {
  test('send_file handoff rejects ' + label + ' mismatches before upload', async () => {
    const harness = createHarness({ readContent });
    await waitFor(() => harness.errorBox.hidden === false, label + ' error');
    assert.equal(harness.uploadCount, 0);
    assert.equal(harness.closeCount, 0);
    assert.match(harness.errorBox.textContent, pattern);
  });
}

test('send_file handoff reports upload failures without a success close', async () => {
  const harness = createHarness({
    upload: async () => { throw new Error('upload failed'); },
  });
  await waitFor(() => harness.errorBox.hidden === false, 'upload error');
  assert.equal(harness.uploadCount, 1);
  assert.equal(harness.closeCount, 0);
  assert.match(harness.errorBox.textContent, /upload failed/i);
});

test('send_file handoff reports a missing host upload API', async () => {
  const harness = createHarness({ includeUpload: false });
  await waitFor(() => harness.errorBox.hidden === false, 'missing upload API');
  assert.equal(harness.readCount, 0);
  assert.equal(harness.uploadCount, 0);
  assert.equal(harness.closeCount, 0);
  assert.match(harness.errorBox.textContent, /upload is unavailable/i);
});

test('send_file handoff rejects an upload response without fileId', async () => {
  const harness = createHarness({ upload: async () => ({}) });
  await waitFor(() => harness.errorBox.hidden === false, 'missing fileId');
  assert.equal(harness.uploadCount, 1);
  assert.equal(harness.closeCount, 0);
  assert.match(harness.errorBox.textContent, /returned no fileId/i);
});

test('send_file handoff remains visually hidden when requestClose is unavailable', async () => {
  const harness = createHarness({ includeRequestClose: false });
  await waitFor(() => harness.savedState !== null, 'saved handoff state');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.uploadCount, 1);
  assert.equal(harness.closeCount, 0);
  assert.equal(harness.errorBox.hidden, true);
  assert.equal(harness.body.dataset.error, 'false');
  assert.ok(harness.heightCount > 0);
});

test('send_file handoff remains visually hidden when requestClose fails', async () => {
  const harness = createHarness({
    requestClose: async () => { throw new Error('close failed'); },
  });
  await waitFor(() => harness.savedState !== null, 'saved handoff state');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(harness.uploadCount, 1);
  assert.equal(harness.closeCount, 1);
  assert.equal(harness.errorBox.hidden, true);
  assert.equal(harness.body.dataset.error, 'false');
  assert.ok(harness.heightCount > 0);
});

test('send_file handoff UI contains only the hidden handoff surface and error state', () => {
  assert.equal(SEND_FILE_HANDOFF_UI_URI, 'ui://ccm/send-file-handoff.html');
  assert.match(SEND_FILE_HANDOFF_UI_HTML, /requestClose/);
  assert.match(SEND_FILE_HANDOFF_UI_HTML, /uploadFile\(file, \{ library: false \}\)/);
  assert.match(SEND_FILE_HANDOFF_UI_HTML, /id="error" hidden/);
  assert.doesNotMatch(SEND_FILE_HANDOFF_UI_HTML, /<button/i);
  assert.doesNotMatch(SEND_FILE_HANDOFF_UI_HTML, /<a[ >]/i);
});
