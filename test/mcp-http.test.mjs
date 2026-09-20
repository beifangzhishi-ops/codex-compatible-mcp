import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkerRuntime } from '../src/runtime/index.mjs';
import { createControllerRuntime } from '../src/controller/runtime.mjs';
import { RemoteWorkerClient } from '../src/worker/remote-worker-client.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { createToolRegistry } from '../src/tools/index.mjs';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';

test('MCP lists and calls tools through a Remote Worker', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-mcp-'));
  const runtime = createControllerRuntime({ workerPort: 0 });
  const workerRuntime = createWorkerRuntime({
    environment: {
      id: 'mcp-worker',
      cwd: tempRoot,
      permissionProfile: 'workspace-write',
    },
  });
  await runtime.start();

  const worker = new RemoteWorkerClient({
    runtime: workerRuntime,
    workerId: 'mcp-worker',
    port: runtime.workerHub.address.port,
  });
  await worker.connect();
  await runtime.workerHub.waitForEnvironment('mcp-worker');

  const { registry, codeModeManager } = createToolRegistry(runtime);
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
    assert.deepEqual(names, [
      'apply_patch',
      'exec',
      'exec_command',
      'list_environments',
      'respond_to_escalation',
      'tool_search',
      'view_image',
      'wait',
      'write_stdin',
    ]);

    const result = await client.callTool({
      name: 'exec_command',
      arguments: {
        environment_id: 'mcp-worker',
        cmd: 'Write-Output MCP_OK',
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(Object.hasOwn(result, 'resultType'), false);
    assert.match(result.content[0].text, /MCP_OK/);

    const escalation = await client.callTool({
      name: 'exec_command',
      arguments: {
        environment_id: 'mcp-worker',
        cmd: 'Write-Output MCP_ESCALATED_OK',
        sandbox_permissions: 'require_escalated',
        justification: 'Allow this MCP test command once?',
      },
    });
    assert.equal(escalation.isError, undefined);
    assert.equal(escalation.structuredContent.approval_required, true);
    assert.match(escalation.content[0].text, /Approval required/);

    const approvalId = escalation.structuredContent.approval_id;
    const approved = await client.callTool({
      name: 'respond_to_escalation',
      arguments: {
        approval_id: approvalId,
        decision: 'approve',
      },
    });
    assert.equal(approved.isError, undefined);
    assert.equal(approved.structuredContent.state, 'approved');

    const escalatedResult = await client.callTool({
      name: 'exec_command',
      arguments: {
        environment_id: 'mcp-worker',
        cmd: 'Write-Output MCP_ESCALATED_OK',
        sandbox_permissions: 'require_escalated',
        justification: 'Allow this MCP test command once?',
        approval_id: approvalId,
      },
    });
    assert.equal(escalatedResult.isError, undefined);
    assert.match(escalatedResult.content[0].text, /MCP_ESCALATED_OK/);

    const nestedCore = await client.callTool({
      name: 'exec',
      arguments: {
        calls: [{
          tool: 'ccm.exec_command',
          arguments: {
            environment_id: 'mcp-worker',
            cmd: 'Write-Output NESTED_CORE_OK',
          },
        }],
        yield_time_ms: 2000,
      },
    });
    assert.equal(nestedCore.isError, undefined);
    assert.equal(nestedCore.structuredContent.state, 'completed');
    assert.match(
      nestedCore.structuredContent.calls[0]
        .result.structured_content.output,
      /NESTED_CORE_OK/,
    );

    const patchResult = await client.callTool({
      name: 'apply_patch',
      arguments: {
        environment_id: 'mcp-worker',
        patch: [
          '*** Begin Patch',
          '*** Add File: mcp.txt',
          '+patched through MCP',
          '*** End Patch',
        ].join('\n'),
      },
    });
    assert.equal(patchResult.isError, undefined);
    assert.match(patchResult.content[0].text, /A mcp\.txt/);
    assert.equal(
      await fs.readFile(path.join(tempRoot, 'mcp.txt'), 'utf8'),
      'patched through MCP\n',
    );

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2F+QAAAAASUVORK5CYII=',
      'base64',
    );
    await fs.writeFile(path.join(tempRoot, 'tiny.png'), png);
    const imageResult = await client.callTool({
      name: 'view_image',
      arguments: {
        environment_id: 'mcp-worker',
        path: 'tiny.png',
      },
    });
    assert.equal(imageResult.isError, undefined);
    assert.equal(imageResult.content[0].type, 'image');
    assert.equal(imageResult.content[0].mimeType, 'image/png');
    assert.equal(
      Buffer.from(imageResult.content[0].data, 'base64').length,
      png.length,
    );

    const docBytes = Buffer.alloc(3 * 1024 * 1024, 0x61);
    await fs.writeFile(path.join(tempRoot, 'preview.docx'), docBytes);
    const sendFileResult = await client.callTool({
      name: 'exec',
      arguments: {
        calls: [{
          tool: 'ccm-extra.send_file',
          arguments: {
            environment_id: 'mcp-worker',
            path: 'preview.docx',
          },
        }],
        yield_time_ms: 1000,
      },
    });
    assert.equal(sendFileResult.isError, undefined);
    const resource = sendFileResult.content.find((item) => item.type === 'resource');
    assert.ok(resource);
    assert.equal(
      resource.resource.mimeType,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.deepEqual(Buffer.from(resource.resource.blob, 'base64'), docBytes);
    assert.equal(
      sendFileResult.structuredContent.calls[0].result.content[1].data_omitted,
      true,
    );

    registry.register({
      name: 'late_echo',
      namespace: 'dynamic',
      provider: 'mcp-test',
      provenance: 'mcp-test',
      surfaces: { deferred: true, codeMode: true },
      description: 'A capability registered after MCP initialization.',
      inputSchema: {
        value: z.string(),
      },
      supportsParallel: true,
      handler: async (args) => ({
        content: [{ type: 'text', text: args.value }],
        structuredContent: { value: args.value },
      }),
    });

    const listedAfterRegistration = await client.listTools();
    assert.deepEqual(
      listedAfterRegistration.tools.map((tool) => tool.name).sort(),
      names,
    );

    const searchResult = await client.callTool({
      name: 'tool_search',
      arguments: { query: 'late echo' },
    });
    assert.equal(searchResult.isError, undefined);
    assert.equal(
      searchResult.structuredContent.tools[0].qualified_name,
      'dynamic.late_echo',
    );

    const nestedResult = await client.callTool({
      name: 'exec',
      arguments: {
        calls: [{
          tool: 'dynamic.late_echo',
          arguments: { value: 'DEFERRED_OK' },
        }],
        yield_time_ms: 1000,
      },
    });
    assert.equal(nestedResult.isError, undefined);
    assert.equal(nestedResult.structuredContent.state, 'completed');
    assert.equal(
      nestedResult.structuredContent.calls[0]
        .result.structured_content.value,
      'DEFERRED_OK',
    );
    assert.equal(Object.hasOwn(nestedResult, 'resultType'), false);
  } finally {
    await client.close().catch(() => {});
    await worker.close().catch(() => {});
    workerRuntime.close();
    codeModeManager.close();
    await controller.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
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
