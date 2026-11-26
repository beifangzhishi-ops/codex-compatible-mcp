import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { registerAudioProbe } from '../src/tools/audio-probe.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';

test('Gemini-only audio probe keeps GPT and unknown client tool lists and images unchanged', async () => {
  const registry = new ToolRegistry();
  const image = { type: 'image', mimeType: 'image/png', data: 'AQID' };
  registry.register({ name: 'view_image', inputSchema: {}, handler: async () => ({ content: [image] }) });
  const controller = createHttpController({ toolRegistry: registry, runtime: { async close() {} }, port: 0 });
  await controller.start();
  const clients = [];
  const connect = async (name, userAgent) => {
    const client = new Client({ name, version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(controller.endpoint), {
      requestInit: { headers: { 'User-Agent': userAgent } },
    });
    clients.push(client);
    await client.connect(transport);
    return client;
  };
  try {
    const gpt = await connect('mcp', 'openai-mcp/1.0.0');
    const gemini = await connect('Gemini', 'Google');
    const unknown = await connect('other', 'Google-other');
    const list = async (client) => (await client.listTools()).tools.map(tool => tool.name).sort();
    assert.deepEqual(await list(gpt), ['view_image']);
    assert.deepEqual(await list(unknown), await list(gpt));
    assert.deepEqual(await list(gemini), ['test_audio_content', 'view_image']);
    assert.equal(registry.get('test_audio_content'), null);
    const probe = async (format) => {
      const result = await gemini.callTool({ name: 'test_audio_content', arguments: { format } });
      assert.equal(result.isError, undefined);
      return result.content;
    };
    const [audio] = await probe('native');
    assert.equal(audio.type, 'audio');
    assert.equal(audio.mimeType, 'audio/wav');
    const wav = Buffer.from(audio.data, 'base64');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.readUInt32LE(40), wav.length - 44);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.deepEqual(await probe('native'), [audio]);
    assert.deepEqual(await probe('mixed'), [{ type: 'text', text: 'CCM_AUDIO_TEST_MARKER' }, audio]);
    assert.deepEqual(await probe('embedded'), [{ type: 'resource', resource: {
      uri: 'urn:ccm:test-audio-content', mimeType: audio.mimeType, blob: audio.data,
    } }]);
    const [inline] = await probe('inline_data');
    assert.deepEqual(JSON.parse(inline.text), { inlineData: { mimeType: audio.mimeType, data: audio.data } });
    assert.deepEqual(await probe('markdown_data_uri'), [{ type: 'text', text: `[Test audio](data:audio/wav;base64,${audio.data})` }]);
    assert.deepEqual(await probe('text_control'), [{ type: 'text', text: 'CCM_AUDIO_TEXT_CONTROL_OK' }]);
    assert.deepEqual((await gpt.callTool({ name: 'view_image', arguments: {} })).content, [image]);
    assert.deepEqual((await unknown.callTool({ name: 'view_image', arguments: {} })).content, [image]);
    const [embedded] = (await gemini.callTool({ name: 'view_image', arguments: {} })).content;
    assert.equal(embedded.type, 'resource');
    assert.equal(embedded.resource.blob, image.data);
    assert.equal(embedded.resource.mimeType, image.mimeType);
    assert.deepEqual(await list(gpt), ['view_image']);
  } finally {
    for (const client of clients) await client.close();
    await controller.close();
  }
});

test('audio probe rejects calls without the observed Google request User-Agent', async () => {
  const registry = new ToolRegistry();
  registerAudioProbe(registry);
  const probe = registry.get('test_audio_content');
  for (const userAgent of [undefined, 'openai-mcp/1.0.0', 'Google-other']) {
    const result = await probe.handler({}, { extra: { requestInfo: { headers: { 'user-agent': userAgent } } } });
    assert.equal(result.isError, true);
    assert.ok(result.content.every(item => item.type === 'text'));
  }
});
