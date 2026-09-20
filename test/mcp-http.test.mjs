import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkerRuntime } from '../src/runtime/index.mjs';
import { createControllerRuntime } from '../src/controller/runtime.mjs';
import { RemoteWorkerClient } from '../src/worker/remote-worker-client.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';

test('MCP lists and calls tools through a Remote Worker', async () => {
  const runtime = createControllerRuntime({ workerPort: 0 });
  const workerRuntime = createWorkerRuntime();
  await runtime.start();

  const worker = new RemoteWorkerClient({
    runtime: workerRuntime,
    port: runtime.workerHub.address.port,
  });
  await worker.connect();
  await runtime.workerHub.waitForEnvironment('6v1f');

  const registry = registerCoreTools(new ToolRegistry(), runtime);
  const controller = createHttpController({ toolRegistry: registry, runtime, port: 0 });
  await controller.start();

  const client = new Client({ name: 'ccm-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + controller.address.port + '/ccm/mcp'),
  );

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['exec_command', 'list_environments', 'write_stdin']);

    const result = await client.callTool({
      name: 'exec_command',
      arguments: { cmd: 'Write-Output MCP_OK' },
    });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /MCP_OK/);
  } finally {
    await client.close().catch(() => {});
    await worker.close().catch(() => {});
    workerRuntime.close();
    await controller.close();
  }
});


test('MCP blocks oversized tool results before transport', async () => {
  const runtime = createWorkerRuntime();
  const registry = new ToolRegistry();
  registry.register({
    name: 'oversized_test',
    description: 'Test-only oversized result.',
    inputSchema: {},
    handler: async () => ({
      content: [{ type: 'text', text: 'x'.repeat(100_000) }],
    }),
  });
  const controller = createHttpController({
    toolRegistry: registry,
    runtime,
    port: 0,
    maxToolResultBytes: 65_536,
  });
  await controller.start();

  const port = controller.address.port;
  const client = new Client({ name: 'ccm-size-test', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + port + '/ccm/mcp'),
  );
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: 'oversized_test',
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /blocked oversized tool result/);
    assert.ok(result.content[0].text.length < 1024);
  } finally {
    await client.close().catch(() => {});
    await controller.close();
  }
});
