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
  statusResult = null,
  widgetState = null,
  nonce = 'secret-card-capability-1234567890',
  globalsBeforeInitialize = false,
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
    'contextRow',
    'contextKey',
    'copyKey',
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
        const initializedResult = {
          protocolVersion: '2026-01-26',
          hostCapabilities,
          hostContext: {},
          hostInfo: {
            name: 'test-host',
            version: '1',
          },
        };
        if (globalsBeforeInitialize) {
          queueMicrotask(() => {
            for (const listener of eventListeners.get('openai:set_globals') || []) listener();
            respond(initializedResult);
          });
        } else {
          respond(initializedResult);
        }
        return;
      }
      if (message.method === 'tools/call') {
        if (message.params.name === 'get_approval_status') {
          respond({ structuredContent: statusResult || {
            approval_id: initialApproval.approval_id,
            operation_id: initialApproval.operation_id,
            kind: initialApproval.kind,
            operation: initialApproval.operation || null,
            state: 'pending',
          } });
          return;
        }
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
    widgetState,
    setWidgetState: async (value) => { openai.widgetState = value; },
    toolResponseMetadata: {
      mcp_tool_result: {
        structuredContent: initialApproval,
        _meta: {
          approval_nonce: nonce,
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
    openai,
    click(id) {
      elements[id].dispatch('click');
    },
    replayInitial() {
      for (const listener of eventListeners.get('openai:set_globals') || []) listener();
    },
  };
}

test('reopened approved project restores the Key from read-only status, never reapproves or continues', async () => {
  const context = '00000000-0000-4000-8000-000000000099';
  const initial = executionApproval({ kind: 'workspace', operation: 'register_workspace' });
  const final = terminalExecution({
    ...initial,
    state: 'consumed',
    approval_required: false,
    workspace_context: context,
    workspace_kind: 'registered',
    exit_code: undefined,
  });
  const card = await createApprovalAppHarness({ initialApproval: initial, statusResult: final });
  await waitFor(() => card.elements.contextKey.textContent === context, 'recovered key');
  assert.equal(card.elements.approve.disabled, true);
  assert.equal(card.elements.deny.disabled, true);
  card.replayInitial();
  card.click('approve');
  assert.equal(card.elements.contextKey.textContent, context);
  assert.equal(card.elements.contextRow.hidden, false);
  assert.equal(card.openai.widgetState?.workspace_context, context);
  assert.equal(card.calls.filter(x => x.params?.name === 'resolve_pending_action').length, 0);
  assert.equal(card.calls.filter(x => x.method === 'ui/message').length, 0);
});

test('web-style globals before initialize still trigger one authenticated terminal lookup', async () => {
  const context = '00000000-0000-4000-8000-000000000088';
  const initial = executionApproval({ kind: 'workspace', operation: 'select_workspace' });
  const card = await createApprovalAppHarness({
    globalsBeforeInitialize: true,
    initialApproval: initial,
    statusResult: {
      approval_id: initial.approval_id,
      operation_id: initial.operation_id,
      kind: initial.kind,
      operation: initial.operation,
      state: 'consumed',
      workspace_context: context,
      workspace_kind: 'registered',
    },
  });
  await waitFor(() => card.elements.contextKey.textContent === context, 'terminal lookup after early globals');
  assert.equal(card.elements.contextRow.hidden, false);
  assert.equal(card.elements.approve.disabled, true);
  assert.equal(card.elements.deny.disabled, true);
  assert.equal(card.calls.filter((call) => call.params?.name === 'get_approval_status').length, 1);
  assert.equal(card.calls.filter((call) => call.params?.name === 'resolve_pending_action').length, 0);
  assert.equal(card.calls.filter((call) => call.method === 'ui/message').length, 0);
});

test('web-style globals before initialize verify a pending card without duplicating queries', async () => {
  const card = await createApprovalAppHarness({ globalsBeforeInitialize: true });
  await waitFor(() => card.elements.status.textContent === 'Waiting for your decision.', 'pending verification after early globals');
  assert.equal(card.elements.approve.disabled, false);
  assert.equal(card.elements.deny.disabled, false);
  assert.equal(card.calls.filter((call) => call.params?.name === 'get_approval_status').length, 1);
  assert.equal(card.calls.filter((call) => call.params?.name === 'resolve_pending_action').length, 0);
});

test('reopened card restores matching widgetState while a status query is unavailable, but cannot approve', async () => {
  const context = '00000000-0000-4000-8000-000000000099';
  const initial = executionApproval({ kind: 'workspace', operation: 'select_workspace' });
  const card = await createApprovalAppHarness({
    initialApproval: initial,
    nonce: null,
    widgetState: {
      version: 1,
      approval_id: initial.approval_id,
      operation_id: initial.operation_id,
      kind: 'workspace',
      operation: 'select_workspace',
      state: 'consumed',
      action_failed: false,
      workspace_context: context,
    },
  });
  assert.equal(card.elements.contextKey.textContent, context);
  assert.equal(card.elements.approve.disabled, true);
  card.replayInitial();
  assert.equal(card.elements.contextKey.textContent, context);
  card.click('approve');
  assert.equal(card.calls.filter(x => x.params?.name === 'resolve_pending_action').length, 0);
});

test('reopened pending card requires an authenticated query before enabling approval', async () => {
  const card = await createApprovalAppHarness({ nonce: null });
  assert.equal(card.elements.approve.disabled, true);
  card.click('approve');
  assert.equal(card.calls.filter(x => x.params?.name === 'resolve_pending_action').length, 0);
  assert.match(card.elements.status.textContent, /capability unavailable/i);
});

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
    harness.calls.filter((call) => call.method === 'tools/call' &&
      call.params?.name === 'resolve_pending_action').length,
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
    harness.calls.filter((call) => call.method === 'tools/call' &&
      call.params?.name === 'resolve_pending_action').length,
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
    harness.calls.filter((call) => call.method === 'tools/call' &&
      call.params?.name === 'resolve_pending_action').length,
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
  assert.equal(harness.elements.contextRow.hidden, false);
  assert.equal(harness.elements.contextKey.textContent, workspaceContext);
  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    1,
  );
});

test('workspace key is not shown for denial, failure or absent context', async () => {
  const failed = [
    { state: 'denied', workspace_context: '00000000-0000-4000-8000-000000000099' },
    { state: 'consumed', action_failed: true, workspace_context: '00000000-0000-4000-8000-000000000099' },
    { state: 'consumed', workspace_context: undefined },
  ];
  for (const overrides of failed) {
    const harness = await createApprovalAppHarness({
      hostCapabilities: { message: { text: {} } },
      initialApproval: executionApproval({ kind: 'workspace', operation: 'register_workspace' }),
      toolResults: [terminalExecution({ kind: 'workspace', operation: 'register_workspace', exit_code: undefined, ...overrides })],
    });
    harness.click(overrides.state === 'denied' ? 'deny' : 'approve');
    await waitFor(() => harness.calls.some((call) => call.method === 'ui/message'), 'workspace terminal decision');
    assert.equal(harness.elements.contextRow.hidden, true);
    assert.equal(harness.elements.contextKey.textContent, '');
  }
});

test('successful workspace key remains visible even when host continuation fails', async () => {
  const workspaceContext = '00000000-0000-4000-8000-000000000099';
  const harness = await createApprovalAppHarness({
    contextError: 'host unavailable',
    initialApproval: executionApproval({ kind: 'workspace', operation: 'register_workspace' }),
    toolResults: [terminalExecution({ kind: 'workspace', operation: 'register_workspace', workspace_context: workspaceContext, exit_code: undefined })],
  });
  harness.click('approve');
  await waitFor(() => /handoff failed/i.test(harness.elements.status.textContent), 'handoff error');
  assert.equal(harness.elements.contextRow.hidden, false);
  assert.equal(harness.elements.contextKey.textContent, workspaceContext);
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
    (call) => call.method === 'tools/call' &&
      call.params?.name === 'resolve_pending_action',
  );
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].params.arguments.decision, 'deny');
  assert.equal(
    harness.calls.filter((call) => call.method === 'ui/message').length,
    1,
  );
});
