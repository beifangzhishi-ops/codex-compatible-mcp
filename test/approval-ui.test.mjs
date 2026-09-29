import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import {
  APPROVAL_UI_HTML,
  APPROVAL_UI_URI,
} from '../src/ui/approval-app.mjs';

function approvalScript() {
  const match = APPROVAL_UI_HTML.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(match, 'approval UI must contain one inline script');
  return match[1];
}

function executionApproval(overrides = {}) {
  return {
    approval_id: '00000000-0000-4000-8000-000000000002',
    operation_id: '00000000-0000-4000-8000-000000000003',
    state: 'pending',
    kind: 'execution',
    environment_id: 'approval-worker',
    command: 'Write-Output APPROVAL_UI_OK',
    workdir: null,
    tty: false,
    shell: null,
    policy_persistable: false,
    justification: 'Approve this frozen test command?',
    expires_at: '2026-09-23T08:00:00.000Z',
    intent_sha256: 'a'.repeat(64),
    workspace_context: '00000000-0000-4000-8000-000000000001',
    workspace_id: 'approval-workspace',
    workspace_kind: 'registered',
    workspace_root: 'C:\\workspace',
    ...overrides,
  };
}

function terminalExecution(overrides = {}) {
  return {
    ...executionApproval(),
    approval_required: false,
    state: 'consumed',
    wall_time_seconds: 0.01,
    output: 'APPROVAL_UI_OK',
    exit_code: 0,
    ...overrides,
  };
}

function createElement(initialText = '') {
  const listeners = new Map();
  return {
    textContent: initialText,
    dataset: {},
    disabled: false,
    hidden: false,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
  };
}

async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail('Timed out waiting for ' + label);
}

async function createApprovalAppHarness({
  hostCapabilities = {},
  initialApproval = executionApproval(),
  toolResults = [terminalExecution()],
  messageResult = {},
  messageError = null,
  contextError = null,
  alias = 'success',
} = {}) {
  const calls = [];
  const elements = Object.fromEntries([
    'title',
    'justification',
    'workspace',
    'environment',
    'expires',
    'policyScopeRow',
    'policyScope',
    'command',
    'status',
    'approve',
    'approveAlways',
    'deny',
  ].map((id) => [id, createElement(
    id === 'status' ? 'Waiting for your decision.' : '',
  )]));
  const eventListeners = new Map();
  let initialized = false;
  let toolResultIndex = 0;

  const parent = {
    postMessage(message) {
      calls.push({
        channel: 'bridge',
        method: message.method,
        params: message.params,
      });
      if (!Object.hasOwn(message, 'id')) {
        if (message.method === 'ui/notifications/initialized') {
          initialized = true;
        }
        return;
      }

      const respond = (result, error = null) => {
        queueMicrotask(() => {
          const listeners = eventListeners.get('message') || [];
          const data = error
            ? { jsonrpc: '2.0', id: message.id, error }
            : { jsonrpc: '2.0', id: message.id, result };
          for (const listener of listeners) {
            listener({ source: parent, data });
          }
        });
      };

      if (message.method === 'ui/initialize') {
        respond({
          protocolVersion: '2026-01-26',
          hostCapabilities,
          hostContext: {},
          hostInfo: {
            name: 'test-host',
            version: '1',
          },
        });
        return;
      }
      if (message.method === 'tools/call') {
        const structuredContent = toolResults[
          Math.min(toolResultIndex, toolResults.length - 1)
        ];
        toolResultIndex += 1;
        respond({ structuredContent });
        return;
      }
      if (message.method === 'ui/update-model-context') {
        if (contextError) {
          respond(null, { code: -32000, message: contextError });
        } else {
          respond({});
        }
        return;
      }
      if (message.method === 'ui/message') {
        if (messageError) {
          respond(null, { code: -32000, message: messageError });
        } else {
          respond(messageResult);
        }
        return;
      }
      respond({});
    },
  };

  const openai = {
    toolResponseMetadata: {
      mcp_tool_result: {
        structuredContent: initialApproval,
        _meta: {
          approval_nonce: 'secret-card-capability-1234567890',
        },
      },
    },
    notifyIntrinsicHeight() {},
  };
  if (alias !== 'missing') {
    openai.sendFollowUpMessage = async (params) => {
      calls.push({
        channel: 'alias',
        method: 'sendFollowUpMessage',
        params,
      });
      if (alias === 'reject') {
        throw new Error('alias rejected');
      }
    };
  }

  const window = {
    parent,
    openai,
    addEventListener(type, listener) {
      const current = eventListeners.get(type) || [];
      current.push(listener);
      eventListeners.set(type, current);
    },
  };
  const document = {
    getElementById(id) {
      return elements[id];
    },
  };

  vm.runInNewContext(approvalScript(), {
    window,
    document,
    Map,
    Object,
    Array,
    Boolean,
    String,
    Promise,
    Error,
    setTimeout,
    clearTimeout,
  });
  await waitFor(() => initialized, 'approval app initialization');

  return {
    calls,
    elements,
    click(id) {
      elements[id].dispatch('click');
    },
  };
}

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
      execCommand: async (args) => ({
        chunk_id: 'approval',
        wall_time_seconds: 0,
        output: 'Approval required before this command can run outside the sandbox.',
        approval_required: true,
        approval_id: '00000000-0000-4000-8000-000000000002',
        operation_id: '00000000-0000-4000-8000-000000000003',
        kind: 'execution',
        state: 'pending',
        environment_id: 'approval-worker',
        command: args.cmd,
        workdir: null,
        tty: false,
        shell: null,
        prefix_rule: ['Write-Output', 'APPROVAL_UI_OK'],
        policy_kind: 'prefix',
        policy_persistable: true,
        justification: args.justification,
        expires_at: '2026-09-23T08:00:00.000Z',
        intent_sha256: 'a'.repeat(64),
        workspace_context: workspaceContext,
        workspace_id: 'approval-workspace',
        workspace_kind: 'registered',
        workspace_root: 'C:\\workspace',
      }),
      writeStdin: async () => ({ wall_time_seconds: 0, output: '', exit_code: 0 }),
    },
    workspaceContextManager: {},
    workerHub: {},
    approvalManager: {
      getRequest() {
        return { kind: 'execution' };
      },
      prepareAppApproval(approvalId, { hostSession } = {}) {
        assert.equal(approvalId, '00000000-0000-4000-8000-000000000002');
        assert.equal(hostSession ?? null, null);
        return {
          request: {
            approval_id: approvalId,
            operation_id: '00000000-0000-4000-8000-000000000003',
            state: 'pending',
            kind: 'execution',
            environment_id: 'approval-worker',
            command: 'Write-Output APPROVAL_UI_OK',
            workdir: null,
            tty: false,
            shell: null,
            prefix_rule: ['Write-Output', 'APPROVAL_UI_OK'],
            policy_kind: 'prefix',
            policy_persistable: true,
            justification: 'Approve this frozen test command?',
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
      (tool) => tool.name === 'request_approval',
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
    assert.match(resource.contents[0].text, /ui\/message/);
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
      /approveAlways\.hidden = !policyPersistable/,
    );
    assert.match(resource.contents[0].text, /Token prefix:/);
    assert.match(resource.contents[0].text, /policy_save_failed/);
    assert.match(
      resource.contents[0].text,
      /workspace approval result already placed in model context/,
    );

    const pending = await client.callTool({
      name: 'exec_command',
      arguments: {
        workspace_context: workspaceContext,
        cmd: 'Write-Output APPROVAL_UI_OK',
        sandbox_permissions: 'require_escalated',
        justification: 'Approve this frozen test command?',
      },
    });
    assert.equal(pending.structuredContent.approval_required, true);

    const prepared = await client.callTool({
      name: 'request_approval',
      arguments: {
        approval_id: pending.structuredContent.approval_id,
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

test('approval app prefers standard ui/message after model context update', async () => {
  const harness = await createApprovalAppHarness({
    hostCapabilities: {
      message: { text: {} },
      updateModelContext: { text: {}, structuredContent: {} },
    },
  });
  harness.click('approve');
  await waitFor(
    () => harness.calls.some((call) => call.method === 'ui/message'),
    'standard follow-up message',
  );

  const methods = harness.calls.map((call) => call.method);
  assert.ok(
    methods.indexOf('ui/update-model-context') < methods.indexOf('ui/message'),
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    1,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'sendFollowUpMessage').length,
    0,
  );
});

test('approval app falls back to ChatGPT alias after explicit ui/message failure', async () => {
  const harness = await createApprovalAppHarness({
    hostCapabilities: { message: { text: {} } },
    messageResult: { isError: true },
  });
  harness.click('approve');
  await waitFor(
    () => harness.calls.some(
      (call) => call.method === 'sendFollowUpMessage',
    ),
    'compatibility alias fallback',
  );

  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    1,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'sendFollowUpMessage').length,
    1,
  );
});

test('approval app uses ChatGPT alias when standard message capability is absent', async () => {
  const harness = await createApprovalAppHarness({
    hostCapabilities: {},
  });
  harness.click('approve');
  await waitFor(
    () => harness.calls.some(
      (call) => call.method === 'sendFollowUpMessage',
    ),
    'compatibility alias',
  );

  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    0,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'sendFollowUpMessage').length,
    1,
  );
});

test('approval app reports manual continuation when no follow-up route works', async () => {
  const harness = await createApprovalAppHarness({
    hostCapabilities: { message: { text: {} } },
    messageError: 'message bridge failed',
    alias: 'reject',
  });
  harness.click('approve');
  await waitFor(
    () => harness.elements.status.textContent.includes(
      'did not continue automatically',
    ),
    'manual continuation warning',
  );

  assert.match(harness.elements.status.textContent, /Approved and completed/);
  assert.match(
    harness.elements.status.textContent,
    /Send a message to continue/,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'tools/call').length,
    1,
  );
});

test('approval app does not trigger a follow-up when model context handoff fails', async () => {
  const harness = await createApprovalAppHarness({
    hostCapabilities: { message: { text: {} } },
    contextError: 'context bridge failed',
  });
  harness.click('approve');
  await waitFor(
    () => harness.elements.status.textContent.includes(
      'context handoff failed',
    ),
    'context handoff warning',
  );

  assert.match(harness.elements.status.textContent, /Approved and completed/);
  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    0,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'sendFollowUpMessage').length,
    0,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'tools/call').length,
    1,
  );
});

test('approval app does not continue while an approved action is retryable', async () => {
  const harness = await createApprovalAppHarness({
    hostCapabilities: { message: { text: {} } },
    toolResults: [
      terminalExecution({
        state: 'approved_retryable',
        exit_code: undefined,
        output: 'Dispatch failed before execution.',
      }),
      terminalExecution(),
    ],
  });
  harness.click('approve');
  await waitFor(
    () => harness.elements.status.textContent.includes(
      'Dispatch failed before execution.',
    ),
    'retryable approval result',
  );

  assert.equal(
    harness.calls.filter(
      (call) => call.method === 'ui/update-model-context',
    ).length,
    0,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    0,
  );

  harness.click('approve');
  await waitFor(
    () => harness.calls.some((call) => call.method === 'ui/message'),
    'follow-up after successful retry',
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'tools/call').length,
    2,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    1,
  );
});

test('workspace approval publishes its workspace context before one follow-up', async () => {
  const workspaceContext = '00000000-0000-4000-8000-000000000099';
  const harness = await createApprovalAppHarness({
    hostCapabilities: { message: { text: {} } },
    initialApproval: executionApproval({
      kind: 'workspace',
      operation: 'select_workspace',
      command: undefined,
    }),
    toolResults: [
      terminalExecution({
        kind: 'workspace',
        operation: 'select_workspace',
        workspace_context: workspaceContext,
        exit_code: undefined,
        output: 'Approved and entered workspace.',
      }),
    ],
  });
  harness.click('approve');
  await waitFor(
    () => harness.calls.some((call) => call.method === 'ui/message'),
    'workspace follow-up',
  );

  const contextCall = harness.calls.find(
    (call) => call.method === 'ui/update-model-context',
  );
  assert.equal(
    contextCall.params.structuredContent.workspace_context,
    workspaceContext,
  );
  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    1,
  );
});

test('denial sends one continuation without introducing another resolver call', async () => {
  const harness = await createApprovalAppHarness({
    hostCapabilities: { message: { text: {} } },
    toolResults: [
      terminalExecution({
        state: 'denied',
        exit_code: undefined,
        output: 'Denied.',
      }),
    ],
  });
  harness.click('deny');
  await waitFor(
    () => harness.calls.some((call) => call.method === 'ui/message'),
    'denial follow-up',
  );

  const resolverCalls = harness.calls.filter(
    (call) => call.method === 'tools/call',
  );
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].params.arguments.decision, 'deny');
  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    1,
  );
});
