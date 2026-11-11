import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as z from 'zod/v4';
import { ApprovalManager } from '../src/controller/approval-manager.mjs';
import { GUARDIAN_OUTPUT_SCHEMA, parseGuardianAssessment } from '../src/controller/guardian-assessment.mjs';
import { guardianInstructions } from '../src/controller/guardian-prompts.mjs';
import { CpaReviewClient } from '../src/controller/cpa-review-client.mjs';
import { GuardianReviewer } from '../src/controller/guardian-reviewer.mjs';
import { GuardianToolDispatcher } from '../src/controller/guardian-tool-dispatcher.mjs';
import { isReviewerTool } from '../src/controller/guardian-tool-context.mjs';
import { mayRetryGuardian } from '../src/controller/guardian-retry.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { createToolRegistry } from '../src/tools/index.mjs';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';

const WORKSPACE_HANDLE = '00000000-0000-4000-8000-000000000001';

test('Guardian assessment matches Codex schema defaults and wrapped JSON parser', () => {
  assert.deepEqual(parseGuardianAssessment('{"outcome":"allow"}'), {
    outcome: 'allow', risk_level: 'low', user_authorization: 'unknown',
    rationale: 'Auto-review returned a low-risk allow decision.',
  });
  assert.equal(parseGuardianAssessment('Result: {"outcome":"deny"}\nDone').risk_level, 'high');
  assert.deepEqual(GUARDIAN_OUTPUT_SCHEMA.required, ['outcome']);
  assert.throws(() => parseGuardianAssessment('{"outcome":"approve"}'), /outcome/);
  assert.throws(() => parseGuardianAssessment('{"outcome":"allow","risk_level":"unsafe"}'), /risk_level/);
  assert.throws(() => parseGuardianAssessment('not json'), /valid JSON/);
});

test('Guardian instructions reuse Codex risk policy with approved main-model trust and permissions', () => {
  const instructions = guardianInstructions();
  assert.match(instructions, /Data Exfiltration/);
  assert.match(instructions, /Destructive Actions/);
  assert.match(instructions, /trust the main Host model/i);
  assert.match(instructions, /same effective/i);
  assert.doesNotMatch(instructions, /you can only run read-only commands/i);
});

test('Guardian tool schemas cover every currently model-visible CCM tool', () => {
  const { registry } = createToolRegistry({});
  const advertised = new GuardianToolDispatcher({ registry }).availableTools();
  const names = new Set(advertised.map((tool) => tool.name));
  for (const name of ['exec_command', 'write_stdin', 'apply_patch', 'view_image', 'restart']) {
    assert.equal(names.has(name), true, name);
  }
  assert.equal(names.has('resolve_pending_action'), false);
  assert.equal(names.has('submit_verification_input'), false);
  assert.equal(names.size, advertised.length);
});

function makeRegistry(counter) {
  const registry = new ToolRegistry();
  for (const name of ['inspect_example_action', 'inspect_example_authorization']) {
    registry.register({
      name,
      inputSchema: { workspace_handle: z.string().uuid() },
      description: 'Return a disposable local fixture.',
      handler: async ({ workspace_handle: handle }) => {
        assert.equal(handle, WORKSPACE_HANDLE);
        assert.equal(isReviewerTool(), true);
        counter.push(name);
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    });
  }
  registry.register({
    name: 'app_secret',
    mcpMeta: { ui: { visibility: ['app'] } },
    inputSchema: {},
    handler: async () => { throw new Error('App-only tool must not execute'); },
  });
  return registry;
}

function response(output) {
  return { ok: true, json: async () => ({ output }) };
}

function call(name, callId) {
  return { type: 'function_call', name, call_id: callId, arguments: '{}' };
}

test('CPA stateless history replay executes two original registry tools, then returns allow', async () => {
  const requests = [];
  const calls = [];
  const outputs = [
    [call('inspect_example_action', 'first')],
    [call('inspect_example_authorization', 'second')],
    [{ type: 'message', content: [{ type: 'output_text', text: '{"outcome":"allow"}' }] }],
  ];
  const client = new CpaReviewClient({
    apiKey: 'fixture-only-not-a-secret',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return response(outputs[requests.length - 1]);
    },
  });
  const reviewer = new GuardianReviewer({
    config: { enabled: true, timeout_ms: 5000 },
    client,
    toolRegistry: makeRegistry(calls),
  });
  const result = await reviewer.review({
    approval: { approval_id: 'approval1', intent_sha256: 'fixture-hash' },
    action: {
      workspace_handle: WORKSPACE_HANDLE,
      cmd: 'Write-Output fixture',
      workspace_root: 'C:\\workspace', workspace_id: 'workspace',
      environment_id: 'fixture-worker',
    },
    reviewContext: 'The real user authorized a harmless fixture test.',
  });
  assert.equal(result.outcome, 'allow');
  assert.deepEqual(calls, ['inspect_example_action', 'inspect_example_authorization']);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].input.at(-1).call_id, 'first');
  assert.equal(requests[2].input.at(-1).call_id, 'second');
  assert.equal(requests[0].tools.length, 2);
  assert.equal(requests[0].model, 'codex-auto-review');
  assert.equal(requests[0].previous_response_id, undefined);
});

test('Guardian tool dispatcher uses same effective non-read-only tool handler', async () => {
  let writableEffect = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: 'modify_fixture',
    description: 'Modify an in-memory fixture.',
    inputSchema: { workspace_handle: z.string().uuid(), delta: z.number() },
    handler: async ({ delta }) => {
      assert.equal(isReviewerTool(), true);
      writableEffect += delta;
      return { structuredContent: { modified: writableEffect } };
    },
  });
  const dispatcher = new GuardianToolDispatcher({ registry });
  assert.equal(dispatcher.availableTools()[0].name, 'modify_fixture');
  await dispatcher.invoke('modify_fixture', { delta: 2 }, { workspaceHandle: WORKSPACE_HANDLE });
  assert.equal(writableEffect, 2);
  await assert.rejects(
    dispatcher.invoke('modify_fixture', { delta: 2, workspace_handle: '00000000-0000-4000-8000-000000000002' }, {
      workspaceHandle: WORKSPACE_HANDLE,
    }),
    /differs/,
  );
});

test('Reviewer claim and deny bind exact frozen intent without an App nonce', () => {
  const approvals = new ApprovalManager();
  const action = {
    cmd: 'echo reviewed', workspace_handle: WORKSPACE_HANDLE,
    sandbox_permissions: 'require_escalated',
  };
  const approved = approvals.requestExecution(action, 'fixture-worker');
  assert.throws(
    () => approvals.claimReviewerExecution(approved.approval_id, 'wrong'),
    /identity/,
  );
  const claim = approvals.claimReviewerExecution(approved.approval_id, approved.intent_sha256);
  assert.equal(claim.action.cmd, action.cmd);
  assert.throws(
    () => approvals.claimReviewerExecution(approved.approval_id, approved.intent_sha256),
    /identity/,
  );
  assert.equal(approvals.markAppExecutionConsumed(approved.approval_id).state, 'consumed');
  const denied = approvals.requestExecution(action, 'fixture-worker');
  assert.equal(
    approvals.denyReviewerExecution(denied.approval_id, denied.intent_sha256).state, 'denied',
  );
  assert.throws(
    () => approvals.claimReviewerExecution(denied.approval_id, denied.intent_sha256),
    /identity/,
  );
});

function fixtureManager(guardianReviewer) {
  const environmentRegistry = new EnvironmentRegistry({ resolvePaths: false });
  environmentRegistry.register({
    id: 'fixture-worker', platform: 'windows',
    cwd: 'C:\\workspace', workspaceRoots: ['C:\\workspace'],
    permissionProfile: 'workspace-write', backend: 'remote-worker',
  });
  class WorkerHub extends EventEmitter {
    calls = [];
    async call(environmentId, method, params) {
      this.calls.push({ environmentId, method, params });
      return { chunk_id: 'test', wall_time_seconds: 0.001, output: 'DISPATCHED', exit_code: 0 };
    }
  }
  const workerHub = new WorkerHub();
  const approvalManager = new ApprovalManager();
  const workspaceHandleManager = {
    resolve(handle) {
      assert.equal(handle, WORKSPACE_HANDLE);
      return {
        workspace_handle: WORKSPACE_HANDLE, environment_id: 'fixture-worker',
        workspace_id: 'fixture-ws', workspace_kind: 'registered',
        workspace_root: 'C:\\workspace',
      };
    },
  };
  const processManager = new RemoteProcessManager({
    environmentRegistry, workerHub, workspaceHandleManager, approvalManager,
    guardianReviewer,
  });
  return { processManager, approvalManager, workerHub };
}

test('Guardian allow dispatches frozen escalation once; deny never dispatches', async (t) => {
  const allow = fixtureManager({
    isEnabled: () => true,
    review: async () => ({ outcome: 'allow', risk_level: 'low', rationale: 'authorized' }),
  });
  t.after(() => allow.processManager.close());
  const args = {
    workspace_handle: WORKSPACE_HANDLE, cmd: 'Write-Output harmless',
    shell: 'powershell.exe', sandbox_permissions: 'require_escalated',
    review_context: 'Owner instructed the local harmless test.',
  };
  const result = await allow.processManager.execCommand(args);
  assert.equal(result.review_outcome, 'allow');
  assert.equal(result.state, 'consumed');
  assert.equal(allow.workerHub.calls.length, 1);
  assert.equal(allow.workerHub.calls[0].params.sandbox_permissions, 'approved_escalated');
  assert.equal(allow.workerHub.calls[0].params.review_context, undefined);
  const deny = fixtureManager({
    isEnabled: () => true,
    review: async () => ({ outcome: 'deny', risk_level: 'high', rationale: 'outside scope' }),
  });
  t.after(() => deny.processManager.close());
  const rejected = await deny.processManager.execCommand(args);
  assert.equal(rejected.review_outcome, 'deny');
  assert.equal(rejected.approval_required, false);
  assert.equal(deny.workerHub.calls.length, 0);
});

test('Guardian failure retains the same frozen pending request for human approval', async (t) => {
  const testRig = fixtureManager({
    isEnabled: () => true,
    review: async () => { throw new Error('CPA unavailable'); },
  });
  t.after(() => testRig.processManager.close());
  const result = await testRig.processManager.execCommand({
    workspace_handle: WORKSPACE_HANDLE, cmd: 'Write-Output harmless',
    sandbox_permissions: 'require_escalated',
  });
  assert.equal(result.review_outcome, 'error');
  assert.equal(result.approval_required, true);
  assert.equal(testRig.workerHub.calls.length, 0);
  const card = testRig.approvalManager.prepareAppApproval(result.approval_id);
  assert.equal(card.request.approval_id, result.approval_id);
});

test('Guardian retries an invalid response without executing tools, but not after tool side effects', async () => {
  const counter = [];
  let attempts = 0;
  const client = {
    async complete({ invokeTool }) {
      attempts++;
      if (attempts === 1) return { text: 'unparseable', rounds: 1, toolCalls: 0 };
      if (attempts === 2) return { text: '{"outcome":"allow"}', rounds: 1, toolCalls: 0 };
      await invokeTool('inspect_example_action', {});
      return { text: 'invalid', rounds: 1, toolCalls: 1 };
    },
  };
  const registry = makeRegistry(counter);
  const reviewer = new GuardianReviewer({
    config: { enabled: true, max_attempts: 3 },
    client, toolRegistry: registry,
  });
  const action = { workspace_handle: WORKSPACE_HANDLE, cmd: 'fixture' };
  const approval = { approval_id: 'x', intent_sha256: 'hash' };
  assert.equal((await reviewer.review({ approval, action })).outcome, 'allow');
  assert.equal(attempts, 2);
  // Subsequent attempts are independent review calls.
  await assert.rejects(reviewer.review({ approval, action }), /valid JSON/);
  assert.equal(attempts, 3);
  assert.equal(counter.length, 1);
  assert.equal(mayRetryGuardian(new Error('temporary'), { toolInvocations: 1 }), false);
  const overloaded = Object.assign(new Error('rate-limited'), { httpStatus: 429 });
  assert.equal(mayRetryGuardian(overloaded), true);
  assert.equal(mayRetryGuardian(Object.assign(new Error('bad request'), { httpStatus: 400 })), false);
});

test('A reviewer tool error prevents a final allow without successful recovery', async () => {
  const client = new CpaReviewClient({
    apiKey: 'fixture',
    fetchImpl: async () => response(
      client.round++ === 0
        ? [call('inspect_example_action', 'first')]
        : [{ type: 'message', content: [{ type: 'output_text', text: '{"outcome":"allow"}' }] }],
    ),
  });
  client.round = 0;
  await assert.rejects(client.complete({
    instructions: 'test', prompt: 'test',
    tools: [{ type: 'function', name: 'inspect_example_action', parameters: { type: 'object', properties: {} } }],
    invokeTool: async () => { throw new Error('fixture tool failed'); },
  }), /unresolved tool failures/);
});

test('Guardian function outputs can carry images with a bounded text wrapper', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'view_fixture',
    inputSchema: { workspace_handle: z.string().uuid() },
    handler: async () => ({ content: [{
      type: 'image', mimeType: 'image/png', data: 'AA==',
    }] }),
  });
  const dispatcher = new GuardianToolDispatcher({ registry });
  const result = await dispatcher.invoke('view_fixture', {}, {
    workspaceHandle: WORKSPACE_HANDLE,
  });
  assert.equal(Array.isArray(result), true);
  assert.equal(result[0].type, 'input_text');
  assert.equal(result[1].type, 'input_image');
  assert.equal(result[1].image_url, 'data:image/png;base64,AA==');
});

test('Reviewer pre-dispatch failures reopen the same frozen human approval', async (t) => {
  const rig = fixtureManager({
    isEnabled: () => true,
    review: async () => ({ outcome: 'allow', risk_level: 'low' }),
  });
  t.after(() => rig.processManager.close());
  rig.workerHub.call = () => { throw new Error('offline before enqueue'); };
  const output = await rig.processManager.execCommand({
    workspace_handle: WORKSPACE_HANDLE,
    cmd: 'Write-Output harmless',
    sandbox_permissions: 'require_escalated',
  });
  assert.equal(output.review_outcome, 'error');
  assert.equal(output.state, 'pending');
  assert.equal(output.approval_required, true);
  const card = rig.approvalManager.prepareAppApproval(output.approval_id);
  assert.equal(card.request.state, 'pending');
});

test('In-flight Worker failure after reviewer allow remains unknown and never retries', async (t) => {
  const rig = fixtureManager({
    isEnabled: () => true,
    review: async () => ({ outcome: 'allow', risk_level: 'low' }),
  });
  t.after(() => rig.processManager.close());
  let calls = 0;
  rig.workerHub.call = async () => { calls++; throw new Error('connection lost after enqueue'); };
  const output = await rig.processManager.execCommand({
    workspace_handle: WORKSPACE_HANDLE,
    cmd: 'Write-Output harmless',
    sandbox_permissions: 'require_escalated',
  });
  assert.equal(output.state, 'execution_unknown');
  assert.equal(output.approval_required, false);
  assert.equal(calls, 1);
});
