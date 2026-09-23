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
import {
  APPROVAL_UI_HTML,
  APPROVAL_UI_URI,
} from '../src/ui/approval-app.mjs';

test('MCP lists and calls tools through a Remote Worker', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-mcp-'));
  const runtime = createControllerRuntime({ workerPort: 0 });
  const workerRuntime = createWorkerRuntime({
    environment: {
      id: 'mcp-worker',
      cwd: tempRoot,
      permissionProfile: 'workspace-write',
    },
    projectlessRoot: path.join(tempRoot, 'projectless'),
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
      'register_workspace',
      'request_escalated_exec',
      'resolve_pending_action',
      'respond_to_escalation',
      'select_workspace',
      'send_file',
      'tool_search',
      'view_image',
      'wait',
      'write_stdin',
    ]);
    assert.deepEqual(
      listed.tools.find((tool) => tool.name === 'resolve_pending_action')
        ?._meta?.ui?.visibility,
      ['app'],
    );
    const approvalTool = listed.tools.find(
      (tool) => tool.name === 'request_escalated_exec',
    );
    assert.equal(approvalTool?._meta?.ui?.resourceUri, APPROVAL_UI_URI);
    assert.equal(
      listed.tools.find((tool) => tool.name === 'select_workspace')
        ?._meta?.ui?.resourceUri,
      APPROVAL_UI_URI,
    );
    assert.equal(
      listed.tools.find((tool) => tool.name === 'register_workspace')
        ?._meta?.ui?.resourceUri,
      APPROVAL_UI_URI,
    );
    const approvalResource = await client.readResource({ uri: APPROVAL_UI_URI });
    assert.equal(approvalResource.contents[0].text, APPROVAL_UI_HTML);
    assert.equal(approvalResource.contents[0]._meta.ui.prefersBorder, true);

    const projectless = await client.callTool({
      name: 'exec',
      arguments: {
        calls: [{
          tool: 'ccm.create_projectless_context',
          arguments: {},
        }],
        yield_time_ms: 1000,
      },
    });
    assert.equal(projectless.isError, undefined);
    assert.equal(projectless.structuredContent.state, 'completed');
    const projectlessResult =
      projectless.structuredContent.calls[0].result.structured_content;
    const workspaceContext = projectlessResult.workspace_context;
    const workspaceRoot = projectlessResult.workspace_root;
    assert.equal(projectlessResult.workspace_kind, 'projectless');

    const seededWorkspace = workerRuntime.workspaceRegistry.list()[0];
    const workspaceApproval = await client.callTool({
      name: 'select_workspace',
      arguments: {
        environment_id: 'mcp-worker',
        workspace_id: seededWorkspace.workspace_id,
      },
    });
    assert.equal(workspaceApproval.isError, undefined);
    assert.equal(workspaceApproval.structuredContent.kind, 'workspace');
    assert.equal(
      workspaceApproval.structuredContent.operation,
      'select_workspace',
    );
    assert.equal(typeof workspaceApproval._meta?.approval_nonce, 'string');
    const workspaceLegacyBypass = await client.callTool({
      name: 'respond_to_escalation',
      arguments: {
        approval_id: workspaceApproval.structuredContent.approval_id,
        decision: 'approve',
      },
    });
    assert.equal(workspaceLegacyBypass.isError, true);
    assert.match(workspaceLegacyBypass.content[0].text, /approval card/i);
    const workspacePersistentBypass = await client.callTool({
      name: 'resolve_pending_action',
      arguments: {
        approval_id: workspaceApproval.structuredContent.approval_id,
        approval_nonce: workspaceApproval._meta.approval_nonce,
        decision: 'approve_workspace',
      },
    });
    assert.equal(workspacePersistentBypass.isError, true);
    assert.match(
      workspacePersistentBypass.content[0].text,
      /only available for execution approvals/i,
    );
    const selectedWorkspace = await client.callTool({
      name: 'resolve_pending_action',
      arguments: {
        approval_id: workspaceApproval.structuredContent.approval_id,
        approval_nonce: workspaceApproval._meta.approval_nonce,
        decision: 'approve',
      },
    });
    assert.equal(selectedWorkspace.isError, undefined);
    assert.equal(selectedWorkspace.structuredContent.state, 'consumed');
    assert.equal(
      selectedWorkspace.structuredContent.workspace_kind,
      'registered',
    );
    assert.equal(
      selectedWorkspace.structuredContent.workspace_id,
      seededWorkspace.workspace_id,
    );

    const result = await client.callTool({
      name: 'exec_command',
      arguments: {
        workspace_context: workspaceContext,
        cmd: 'Write-Output MCP_OK',
      },
    });
    assert.equal(result.isError, undefined);
    assert.equal(Object.hasOwn(result, 'resultType'), false);
    assert.match(result.content[0].text, /MCP_OK/);
    assert.equal(result.structuredContent.workspace_kind, 'projectless');

    const escalation = await client.callTool({
      name: 'request_escalated_exec',
      arguments: {
        workspace_context: workspaceContext,
        cmd: 'Write-Output MCP_ESCALATED_OK',
        justification: 'Allow this MCP test command once?',
      },
    });
    assert.equal(escalation.isError, undefined);
    assert.equal(escalation.structuredContent.approval_required, true);
    assert.match(escalation.content[0].text, /approval card/i);
    assert.equal(typeof escalation._meta?.approval_nonce, 'string');

    const approvalId = escalation.structuredContent.approval_id;
    const legacyBypass = await client.callTool({
      name: 'respond_to_escalation',
      arguments: {
        approval_id: approvalId,
        decision: 'approve',
      },
    });
    assert.equal(legacyBypass.isError, true);
    assert.match(legacyBypass.content[0].text, /approval card/i);

    const escalatedResult = await client.callTool({
      name: 'resolve_pending_action',
      arguments: {
        approval_id: approvalId,
        approval_nonce: escalation._meta.approval_nonce,
        decision: 'approve',
      },
    });
    assert.equal(escalatedResult.isError, undefined);
    assert.match(escalatedResult.content[0].text, /MCP_ESCALATED_OK/);
    assert.equal(escalatedResult.structuredContent.state, 'consumed');

    const nestedCore = await client.callTool({
      name: 'exec',
      arguments: {
        calls: [{
          tool: 'ccm.exec_command',
          arguments: {
            workspace_context: workspaceContext,
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
        workspace_context: workspaceContext,
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
      await fs.readFile(path.join(workspaceRoot, 'mcp.txt'), 'utf8'),
      'patched through MCP\n',
    );

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2F+QAAAAASUVORK5CYII=',
      'base64',
    );
    await fs.writeFile(path.join(workspaceRoot, 'tiny.png'), png);
    const imageResult = await client.callTool({
      name: 'exec',
      arguments: {
        calls: [{
          tool: 'ccm.view_image',
          arguments: {
            workspace_context: workspaceContext,
            path: 'tiny.png',
          },
        }],
        yield_time_ms: 1000,
      },
    });
    assert.equal(imageResult.isError, undefined);
    const nestedImage = imageResult.content.find((item) => item.type === 'image');
    assert.ok(nestedImage);
    assert.equal(nestedImage.mimeType, 'image/png');
    assert.equal(
      Buffer.from(nestedImage.data, 'base64').length,
      png.length,
    );
    assert.equal(
      imageResult.structuredContent.calls[0].result.content[0].data_omitted,
      true,
    );

    const docBytes = Buffer.alloc(3 * 1024 * 1024, 0x61);
    await fs.writeFile(path.join(workspaceRoot, 'preview.docx'), docBytes);
    const sendFileResult = await client.callTool({
      name: 'exec',
      arguments: {
        calls: [{
          tool: 'ccm-extra.send_file',
          arguments: {
            workspace_context: workspaceContext,
            path: 'preview.docx',
          },
        }],
        yield_time_ms: 1000,
      },
    });
    assert.equal(sendFileResult.isError, undefined);
    const resourceLink = sendFileResult.content.find(
      (item) => item.type === 'resource_link',
    );
    assert.ok(resourceLink);
    assert.equal(
      resourceLink.mimeType,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.equal(resourceLink.size, docBytes.length);
    assert.equal(
      sendFileResult.structuredContent.calls[0].result.content[1].type,
      'resource_link',
    );
    const readFileResult = await client.readResource({ uri: resourceLink.uri });
    assert.equal(readFileResult.contents.length, 1);
    assert.equal(readFileResult.contents[0].mimeType, resourceLink.mimeType);
    assert.deepEqual(
      Buffer.from(readFileResult.contents[0].blob, 'base64'),
      docBytes,
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
