import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import {
  APPROVAL_UI_HTML,
  APPROVAL_UI_URI,
} from '../src/ui/approval-app.mjs';

test('approval app keeps its capability in result _meta and resolves only the frozen action', async () => {
  const workspaceContext = '00000000-0000-4000-8000-000000000001';
  let resolvedArgs = null;
  const runtime = {
    environmentRegistry: {
      defaultEnvironmentId: 'approval-worker',
      listPublic: () => [],
    },
    fileTransferStore: { get: () => null },
    processManager: {
      prepareEscalatedCommand(args) {
        assert.equal(args.cmd, 'Write-Output APPROVAL_UI_OK');
        assert.equal(args.workspace_context, workspaceContext);
        return {
          value: {
            chunk_id: 'approval',
            wall_time_seconds: 0,
            output: 'Waiting for approval.',
            approval_required: true,
            approval_id: '00000000-0000-4000-8000-000000000002',
            operation_id: '00000000-0000-4000-8000-000000000003',
            state: 'pending',
            environment_id: 'approval-worker',
            command: args.cmd,
            workdir: null,
            tty: false,
            shell: null,
            justification: args.justification,
            expires_at: '2026-09-23T08:00:00.000Z',
            intent_sha256: 'a'.repeat(64),
            workspace_context: workspaceContext,
            workspace_id: 'approval-workspace',
            workspace_kind: 'registered',
            workspace_root: 'C:\\workspace',
          },
          approvalNonce: 'secret-card-capability-1234567890',
        };
      },
      async resolvePendingExecution(args) {
        resolvedArgs = args;
        return {
          chunk_id: 'done',
          wall_time_seconds: 0.01,
          output: 'APPROVAL_UI_OK',
          exit_code: 0,
          approval_id: args.approval_id,
          operation_id: '00000000-0000-4000-8000-000000000003',
          state: 'consumed',
          workspace_context: workspaceContext,
          environment_id: 'approval-worker',
          workspace_id: 'approval-workspace',
          workspace_kind: 'registered',
          workspace_root: 'C:\\workspace',
        };
      },
      execCommand: async () => ({ wall_time_seconds: 0, output: '', exit_code: 0 }),
      writeStdin: async () => ({ wall_time_seconds: 0, output: '', exit_code: 0 }),
    },
    workspaceContextManager: {},
    workerHub: {},
    approvalManager: {
      getRequest() {
        return { kind: 'execution' };
      },
      respond() {
        throw new Error('not used');
      },
    },
    fileService: {},
    async close() {},
  };
  const registry = registerCoreTools(new ToolRegistry(), runtime);
  const controller = createHttpController({
    toolRegistry: registry,
    runtime,
    port: 0,
  });
  await controller.start();
  const client = new Client({ name: 'approval-ui-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://127.0.0.1:' + controller.address.port + '/ccm/mcp'),
  );
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const requestTool = listed.tools.find(
      (tool) => tool.name === 'request_escalated_exec',
    );
    const resolverTool = listed.tools.find(
      (tool) => tool.name === 'resolve_pending_action',
    );
    assert.equal(requestTool?._meta?.ui?.resourceUri, APPROVAL_UI_URI);
    assert.deepEqual(resolverTool?._meta?.ui?.visibility, ['app']);

    const resource = await client.readResource({ uri: APPROVAL_UI_URI });
    assert.equal(resource.contents[0].text, APPROVAL_UI_HTML);
    assert.match(resource.contents[0].text, /tools\/call/);
    assert.match(resource.contents[0].text, /ui\/update-model-context/);
    assert.match(resource.contents[0].text, /sendFollowUpMessage/);
    assert.match(resource.contents[0].text, /Always allow in workspace/);
    assert.match(resource.contents[0].text, /approve_workspace/);
    assert.match(
      resource.contents[0].text,
      /retryDecision \|\| "approve"/,
    );
    assert.match(
      resource.contents[0].text,
      /retryDecision === "approve_workspace"/,
    );
    assert.match(
      resource.contents[0].text,
      /approveAlways\.hidden = workspaceAction/,
    );
    assert.match(
      resource.contents[0].text,
      /workspace approval result already placed in model context/,
    );

    const prepared = await client.callTool({
      name: 'request_escalated_exec',
      arguments: {
        workspace_context: workspaceContext,
        cmd: 'Write-Output APPROVAL_UI_OK',
        justification: 'Approve this frozen test command?',
      },
    });
    assert.equal(prepared.isError, undefined);
    assert.equal(prepared.structuredContent.state, 'pending');
    assert.equal(
      Object.hasOwn(prepared.structuredContent, 'approval_nonce'),
      false,
    );
    assert.equal(
      prepared._meta.approval_nonce,
      'secret-card-capability-1234567890',
    );

    const resolved = await client.callTool({
      name: 'resolve_pending_action',
      arguments: {
        approval_id: prepared.structuredContent.approval_id,
        approval_nonce: prepared._meta.approval_nonce,
        decision: 'approve',
      },
    });
    assert.equal(resolved.isError, undefined);
    assert.equal(resolved.structuredContent.state, 'consumed');
    assert.equal(resolved.structuredContent.output, 'APPROVAL_UI_OK');
    assert.deepEqual(Object.keys(resolvedArgs).sort(), [
      'approval_id',
      'approval_nonce',
      'decision',
    ]);
  } finally {
    await client.close().catch(() => {});
    await controller.close();
  }
});
