import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { registerAudioProbe } from '../src/tools/audio-probe.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { createConfig } from '../ccm-sidecar/config.mjs';
import { OAuthStore } from '../ccm-sidecar/oauth.mjs';
import { createCcmOAuthServer, listenCcmOAuthServer, closeCcmOAuthServer } from '../ccm-sidecar/server.mjs';

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
    const [mp3] = await probe('mp3_native');
    assert.equal(mp3.type, 'audio');
    assert.equal(mp3.mimeType, 'audio/mpeg');
    const mp3Bytes = Buffer.from(mp3.data, 'base64');
    assert.ok(mp3Bytes.length > 1000 && mp3Bytes.length < wav.length);
    assert.equal(mp3Bytes.toString('ascii', 0, 3), 'ID3');
    const [embeddedMp3] = await probe('mp3_embedded');
    assert.deepEqual(embeddedMp3.resource, { uri: 'urn:ccm:test-audio-content:mp3', mimeType: 'audio/mpeg', blob: mp3.data });
    const annotations = { audience: ['assistant'], priority: 1 };
    assert.deepEqual(await probe('native_assistant'), [{ ...audio, annotations }]);
    assert.deepEqual(await probe('embedded_assistant'), [{ type: 'resource', resource: {
      uri: 'urn:ccm:test-audio-content', mimeType: audio.mimeType, blob: audio.data,
    }, annotations }]);
    for (const [format, sample] of [['resource_link', audio], ['resource_link_mp3', mp3]]) {
      const [link] = await probe(format);
      assert.equal(link.type, 'resource_link');
      assert.equal(link.mimeType, sample.mimeType);
      assert.deepEqual(link.annotations, annotations);
      const resources = (await gemini.listResources()).resources;
      assert.ok(resources.some(resource => resource.uri === link.uri));
      const read = await gemini.readResource({ uri: link.uri });
      assert.deepEqual(read.contents, [{ uri: link.uri, mimeType: sample.mimeType, blob: sample.data }]);
      for (const other of [gpt, unknown]) {
        assert.ok(!(await other.listResources()).resources.some(resource => resource.uri === link.uri));
        await assert.rejects(other.readResource({ uri: link.uri }));
      }
    }
    for (const [format, expected] of [
      ['structured_inline', { inlineData: { mimeType: audio.mimeType, data: audio.data } }],
      ['structured_parts', { result: [{ type: 'audio', mime_type: audio.mimeType, data: audio.data }] }],
    ]) {
      const result = await gemini.callTool({ name: 'test_audio_content', arguments: { format } });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.content, []);
      assert.deepEqual(result.structuredContent, expected);
    }
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

test('OAuth sidecar can resolve both diagnostic audio resource links for real Google-style requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-audio-resource-'));
  const controller = createHttpController({ toolRegistry: new ToolRegistry(), runtime: { async close() {} }, port: 0 });
  await controller.start();
  const config = createConfig({ rootDir: root, readConfigFile: false, configValues: { CCM_ISSUER: 'https://example.test/ccm', CCM_RESOURCE: 'https://example.test/ccm/mcp' }, port: 0, allowEphemeral: true, approvalSecret: 'A'.repeat(32) });
  const store = new OAuthStore(config.stateFile);
  const client = store.registerClient({ client_name: 'Google test', redirect_uris: ['http://127.0.0.1:19001/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
  const token = store.mintTokenPair({ clientId: client.clientId, resource: config.resource, scope: 'mcp', tokenTtlSeconds: 3600 }).accessToken;
  const sidecar = createCcmOAuthServer({ config, oauthStore: store, upstreamUrl: 'http://127.0.0.1:' + controller.address.port + '/ccm' });
  const gemini = new Client({ name: 'Gemini', version: '1' });
  try {
    await listenCcmOAuthServer(sidecar, 0);
    await gemini.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + sidecar.server.address().port + '/ccm/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'Google' } } }));
    for (const [linkFormat, embeddedFormat] of [['resource_link', 'embedded'], ['resource_link_mp3', 'mp3_embedded']]) {
      const link = (await gemini.callTool({ name: 'test_audio_content', arguments: { format: linkFormat } })).content[0];
      assert.equal(link.type, 'resource_link');
      const embedded = (await gemini.callTool({ name: 'test_audio_content', arguments: { format: embeddedFormat } })).content[0];
      const read = await gemini.readResource({ uri: link.uri });
      assert.deepEqual(read.contents, [embedded.resource]);
    }
    const log = await fs.readFile(path.join(config.logDir, 'ccm-http.log'), 'utf8');
    assert.match(log, /MCP BEGIN[^\n]*method=resources\/read[^\n]*userAgent="Google"/);
    assert.ok(!log.includes(token));
  } finally {
    await gemini.close().catch(() => {});
    await closeCcmOAuthServer(sidecar);
    await controller.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
