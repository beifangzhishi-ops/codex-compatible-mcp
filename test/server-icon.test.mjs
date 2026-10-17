import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { readCcmIcon } from '../src/server-icon.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { createConfig } from '../ccm-sidecar/config.mjs';
import { createCcmOAuthServer, listenCcmOAuthServer, closeCcmOAuthServer } from '../ccm-sidecar/server.mjs';

const ICON_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');

test('the tracked CCM icon is a 512x512 PNG within the delivery limit', () => {
  const icon = readCcmIcon();
  assert.ok(icon);
  assert.equal(icon.readUInt32BE(16), 512);
  assert.equal(icon.readUInt32BE(20), 512);
  assert.ok(icon.length <= 512 * 1024);
});

test('initialize exposes the stable same-origin server icon when its PNG exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-icon-mcp-'));
  const iconPath = path.join(root, 'ccm-icon.png');
  await fs.writeFile(iconPath, ICON_BYTES);
  const controller = createHttpController({
    toolRegistry: new ToolRegistry(),
    runtime: {
      fileDownloadOrigin: () => 'https://ccm.example.test',
      environmentRegistry: { defaultEnvironmentId: null, listPublic: () => [] },
      async close() {},
    },
    port: 0,
    iconPath,
  });
  await controller.start();
  const client = new Client({ name: 'icon-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(controller.endpoint));
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().title, 'CCM');
    assert.deepEqual(client.getServerVersion().icons, [{
      src: 'https://ccm.example.test/ccm/preview/icon.png',
      mimeType: 'image/png',
      sizes: ['512x512'],
    }]);
  } finally {
    await transport.close();
    await controller.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('sidecar serves the same stable PNG URL without OAuth', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-icon-sidecar-'));
  const iconPath = path.join(root, 'ccm-icon.png');
  await fs.writeFile(iconPath, ICON_BYTES);
  const config = createConfig({
    rootDir: root, readEnvFile: false, port: 0, allowEphemeral: true,
    approvalSecret: 'A'.repeat(32),
    envValues: {
      CCM_ISSUER: 'https://ccm.example.test/ccm',
      CCM_RESOURCE: 'https://ccm.example.test/ccm/mcp',
    },
  });
  const sidecar = createCcmOAuthServer({ config, iconPath });
  try {
    await listenCcmOAuthServer(sidecar, 0);
    const url = 'http://127.0.0.1:' + sidecar.server.address().port + '/ccm/preview/icon.png';
    const response = await fetch(url + '?utm_source=chatgpt.com');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), ICON_BYTES);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  } finally {
    await closeCcmOAuthServer(sidecar);
    await fs.rm(root, { recursive: true, force: true });
  }
});
