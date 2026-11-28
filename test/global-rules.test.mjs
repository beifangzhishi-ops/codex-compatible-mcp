import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GlobalRules } from '../src/controller/global-rules.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

test('global rules persist, reject stale or invalid saves and preserve empty rules', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-rules-'));
  try {
    const stateFile = path.join(dir, 'global-rules.txt');
    const rules = new GlobalRules({ stateFile });
    const original = rules.read();
    assert.match(original.text, /historical compatibility/);
    const changed = rules.save('中文规则\r\n<example>', original.revision);
    assert.equal(changed.text, '中文规则\n<example>');
    assert.deepEqual(new GlobalRules({ stateFile }).read(), changed);
    assert.throws(() => rules.save('stale', original.revision), /reload/);
    assert.throws(() => rules.save('x'.repeat(4001), changed.revision), /Invalid/);
    assert.throws(() => rules.save('a\0b', changed.revision), /Invalid/);
    assert.deepEqual(rules.read(), changed);
    rules.save('', changed.revision);
    assert.equal(new GlobalRules({ stateFile }).read().text, '');
    assert.match(rules.instructions(), /CCM provides MCP tools/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('new MCP initialization reads saved rules without restarting or changing tools', async () => {
  const globalRules = new GlobalRules();
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({ name: 'probe', description: 'A fixed probe', inputSchema: {}, handler: async () => ({ content: [] }) });
  const controller = createHttpController({
    runtime: { globalRules, async close() {} },
    toolRegistry,
    port: 0,
  });
  await controller.start();
  const clients = [];
  async function connect() {
    const client = new Client({ name: 'rules-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(controller.endpoint)));
    return client;
  }
  try {
    const first = await connect();
    const original = first.getInstructions();
    const tools = await first.listTools();
    globalRules.save('New rule', globalRules.read().revision);
    const second = await connect();
    assert.match(second.getInstructions(), /New rule/);
    assert.doesNotMatch(second.getInstructions(), /historical compatibility/);
    assert.equal(first.getInstructions(), original);
    assert.deepEqual(await second.listTools(), tools);
  } finally {
    for (const client of clients) await client.close();
    await controller.close();
  }
});
