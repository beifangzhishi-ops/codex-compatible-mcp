import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

test('Gemini session receives native WAV audio only; ordinary clients do not see probe', async () => {
  const registry = new ToolRegistry();
  registry.register({ name: 'baseline', description: 'Baseline tool', inputSchema: {}, handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
  const controller = createHttpController({ toolRegistry: registry, runtime: { async close() {} }, port: 0 });
  await controller.start();
  try {
    for (const name of ['ChatGPT', 'ccm-test-client', 'Gemini', 'Google']) {
      const client = new Client({ name, version: '1.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${controller.address.port}/ccm/mcp`)));
        const { tools } = await client.listTools();
        assert.ok(tools.some(tool => tool.name === 'baseline'));
        const expected = name === 'Gemini' || name === 'Google';
        assert.equal(tools.some(tool => tool.name === 'listen_audio'), expected);
        if (!expected) continue;
        const result = await client.callTool({ name: 'listen_audio', arguments: {} });
        const wav = await fs.readFile(new URL('../assets/gemini-audio-probe.wav', import.meta.url));
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
        assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
        assert.ok(wav.length > 100000);
        assert.equal(result.isError, undefined);
        assert.deepEqual(result.content, [{ type: 'audio', mimeType: 'audio/wav', data: wav.toString('base64') }]);
        assert.equal(result.structuredContent, undefined);
      } finally {
        await client.close();
      }
    }
  } finally {
    await controller.close();
  }
});
