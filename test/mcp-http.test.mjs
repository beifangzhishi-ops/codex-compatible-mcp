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
  const runtime = createControllerRuntime({
    workerPort: 0,
    auditLogFile: path.join(tempRoot, 'audit.jsonl'),
    execPolicyStateFile: path.join(tempRoot, 'exec-policy.json'),
    trustedPackageScriptStateFile: path.join(tempRoot, 'trusted-package-scripts.json'),
    workspaceContextStateFile: path.join(tempRoot, 'workspace-contexts.json'),
    fileTransferStateDir: path.join(tempRoot, 'file-transfers'),
    planStateDir: path.join(tempRoot, 'plans'),
  });
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
      'list_projects',
      'receive_file',
      'request_approval',
      'resolve_pending_action',
      'send_file',
      'tool_search',
      'view_image',
      'wait',
      'write_stdin',
    ]);
    const receiveFileTool = listed.tools.find((tool) => tool.name === 'receive_file');
    assert.ok(receiveFileTool);
    assert.deepEqual(receiveFileTool._meta?.['openai/fileParams'], ['file']);
    assert.deepEqual(
      receiveFileTool.inputSchema.properties.file.required,
      ['download_url', 'file_id'],
    );
    assert.equal(
      receiveFileTool.inputSchema.properties.file.additionalProperties,
      false,
    );
    assert.deepEqual(
      Object.keys(receiveFileTool.inputSchema.properties.file.properties).sort(),
      ['download_url', 'file_id', 'file_name', 'mime_type'],
    );
    assert.deepEqual(
      listed.tools.find((tool) => tool.name === 'resolve_pending_action')
        ?._meta?.ui?.visibility,
      ['app'],
    );
    const approvalTool = listed.tools.find(
      (tool) => tool.name === 'request_approval',
    );
    assert.equal(approvalTool?._meta?.ui?.resourceUri, APPROVAL_UI_URI);
    assert.equal(listed.tools.some((tool) => tool.name === 'select_workspace'), false);
    assert.equal(listed.tools.some((tool) => tool.name === 'register_workspace'), false);
    const sendFileTool = listed.tools.find((tool) => tool.name === 'send_file');
    assert.ok(sendFileTool);
    assert.equal(sendFileTool._meta, undefined);
    assert.match(
      sendFileTool.description,
      /include the host-generated native ChatGPT file attachment object in the final response, not its file ID as text/i,
    );
    assert.match(sendFileTool.description, /1 KiB \(1024 bytes\)/i);
    assert.match(sendFileTool.description, /never pad, rewrite, or otherwise alter/i);

    const projectDiscovery = await client.callTool({
      name: 'list_projects',
      arguments: {},
    });
    assert.equal(projectDiscovery.isError, undefined);
    assert.equal(projectDiscovery.structuredContent.default_environment_id, 'mcp-worker');
    assert.equal(projectDiscovery.structuredContent.environments.length, 1);
    assert.equal(projectDiscovery.structuredContent.environments[0].id, 'mcp-worker');
    assert.equal(projectDiscovery.structuredContent.environments[0].projects.length, 1);
    assert.equal(
      projectDiscovery.structuredContent.environments[0].projects[0].project_id,
      workerRuntime.workspaceRegistry.listRegistered()[0].workspace_id,
    );
    assert.equal(
      Object.hasOwn(
        projectDiscovery.structuredContent.environments[0],
        'projectless_contexts',
      ),
      false,
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

    const completeProjectDiscovery = await client.callTool({
      name: 'list_projects',
      arguments: { all: true },
    });
    assert.equal(completeProjectDiscovery.isError, undefined);
    assert.equal(
      completeProjectDiscovery.structuredContent.environments[0]
        .projectless_contexts[0].projectless_id,
      projectlessResult.workspace_id,
    );

    const seededWorkspace = workerRuntime.workspaceRegistry.listRegistered()[0];
    const workspacePrepare = await client.callTool({
      name: 'exec',
      arguments: {
        calls: [{
          tool: 'ccm.select_workspace',
          arguments: {
            environment_id: 'mcp-worker',
            workspace_id: seededWorkspace.workspace_id,
          },
        }],
        yield_time_ms: 1000,
      },
    });
    assert.equal(workspacePrepare.isError, undefined);
    const workspacePending =
      workspacePrepare.structuredContent.calls[0].result.structured_content;
    assert.equal(workspacePending.kind, 'workspace');
    assert.equal(
      workspacePending.operation,
      'select_workspace',
    );
    const workspaceApproval = await client.callTool({
      name: 'request_approval',
      arguments: {
        approval_id: workspacePending.approval_id,
      },
    });
    assert.equal(workspaceApproval.isError, undefined);
    assert.equal(typeof workspaceApproval._meta?.approval_nonce, 'string');
    const workspacePersistentBypass = await client.callTool({
      name: 'resolve_pending_action',
      arguments: {
        approval_id: workspacePending.approval_id,
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
        approval_id: workspacePending.approval_id,
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
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(Object.hasOwn(result, 'resultType'), false);
    assert.match(result.content[0].text, /MCP_OK/);
    assert.equal(result.structuredContent.workspace_kind, 'projectless');

    const escalationPending = await client.callTool({
      name: 'exec_command',
      arguments: {
        workspace_context: workspaceContext,
        cmd: 'Write-Output MCP_ESCALATED_OK',
        sandbox_permissions: 'require_escalated',
        justification: 'Allow this MCP test command once?',
      },
    });
    assert.equal(escalationPending.isError, undefined);
    assert.equal(escalationPending.structuredContent.approval_required, true);
    const escalation = await client.callTool({
      name: 'request_approval',
      arguments: {
        approval_id: escalationPending.structuredContent.approval_id,
      },
    });
    assert.equal(escalation.isError, undefined);
    assert.equal(escalation.structuredContent.approval_required, true);
    assert.match(escalation.content[0].text, /approval card/i);
    assert.equal(typeof escalation._meta?.approval_nonce, 'string');

    const approvalId = escalation.structuredContent.approval_id;
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
      name: 'send_file',
      arguments: {
        workspace_context: workspaceContext,
        path: 'preview.docx',
      },
    });
    assert.equal(sendFileResult.isError, undefined);
    const resourceLink = sendFileResult.content.find(
      (item) => item.type === 'resource_link',
    );
    assert.ok(resourceLink);
    assert.equal(resourceLink.name, 'preview.docx');
    assert.equal(resourceLink.size, docBytes.length);
    assert.equal(
      sendFileResult.structuredContent.mime_type,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    assert.equal(sendFileResult.structuredContent.byte_length, docBytes.length);
    assert.equal(sendFileResult.structuredContent.resource_uri, undefined);
    const resourceUri = resourceLink.uri;
    assert.match(resourceUri, /^ccm-file:\/\/\//);
    assert.equal(resourceLink.mimeType, sendFileResult.structuredContent.mime_type);
    const readFileResult = await client.readResource({ uri: resourceUri });
    assert.equal(readFileResult.contents.length, 1);
    assert.equal(
      readFileResult.contents[0].mimeType,
      sendFileResult.structuredContent.mime_type,
    );
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
