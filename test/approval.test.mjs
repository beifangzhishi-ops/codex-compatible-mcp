import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApprovalManager,
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_TERMINAL_RETENTION_MS,
} from '../src/controller/approval-manager.mjs';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';
import { CodexExecPolicy } from '../src/controller/codex-execpolicy.mjs';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';
import { resolvePermissionProfile } from '../src/runtime/sandbox/sandbox-policy.mjs';

function restrictedRegistry() {
  const registry = new EnvironmentRegistry({ resolvePaths: false });
  registry.register({
    id: 'approval-worker',
    platform: 'windows',
    cwd: 'C:\\workspace',
    workspaceRoots: ['C:\\workspace'],
    permissionProfile: 'workspace-write',
    backend: 'remote-worker',
  });
  return registry;
}

function testCodexPolicy(t, prefixes = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-approval-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policy = new CodexExecPolicy({
    stateFile: path.join(directory, 'default.rules'),
  });
  for (const prefixTokens of prefixes) policy.allow({ prefixTokens });
  return policy;
}

class FakeWorkerHub extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  async call(environmentId, method, params) {
    this.calls.push({ environmentId, method, params });
    return {
      chunk_id: 'fake',
      wall_time_seconds: 0.01,
      output: 'ESCALATED_OK',
      exit_code: 0,
    };
  }
}

test('ApprovalManager defaults to a 3-day approval lifetime', () => {
  assert.equal(DEFAULT_APPROVAL_TTL_MS, 3 * 24 * 60 * 60 * 1000);
  assert.equal(DEFAULT_TERMINAL_RETENTION_MS, 5 * 60 * 1000);

  const now = Date.UTC(2026, 8, 23, 12, 0, 0);
  const approvals = new ApprovalManager({ now: () => now });
  const pending = approvals.requestExecution(
    { cmd: 'Write-Output DEFAULT_TTL' },
    'approval-worker',
  );

  assert.equal(
    Date.parse(pending.expires_at) - now,
    DEFAULT_APPROVAL_TTL_MS,
  );
});

test('ApprovalManager normalizes configured approval durations', () => {
  const configured = new ApprovalManager({ ttlMs: '120000' });
  assert.equal(configured.ttlMs, 120000);

  const invalid = new ApprovalManager({
    ttlMs: 0,
    terminalRetentionMs: Number.NaN,
  });
  assert.equal(invalid.ttlMs, DEFAULT_APPROVAL_TTL_MS);
  assert.equal(
    invalid.terminalRetentionMs,
    DEFAULT_TERMINAL_RETENTION_MS,
  );
});

function fakeWorkspaceHandleManager() {
  return {
    resolve(handleId) {
      assert.equal(handleId, '00000000-0000-4000-8000-000000000001');
      return {
        workspace_handle: handleId,
        environment_id: 'approval-worker',
        workspace_id: 'approval-workspace',
        workspace_kind: 'registered',
        workspace_root: 'C:\\workspace',
      };
    },
  };
}

test('ApprovalManager freezes one exact execution before binding an approval card', () => {
  let now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const approvals = new ApprovalManager({
    ttlMs: 1000,
    now: () => now,
  });
  const workspace = {
    workspace_handle: '00000000-0000-4000-8000-000000000001',
    workspace_id: 'approval-workspace',
    workspace_kind: 'registered',
    workspace_root: 'C:\\workspace',
  };
  const args = {
    workspace_handle: workspace.workspace_handle,
    cmd: 'Write-Output APPROVED',
    workdir: 'C:\\workspace',
    tty: false,
    shell: 'powershell.exe',
    justification: 'Allow this test once?',
  };

  const pending = approvals.requestExecution(
    args,
    'approval-worker',
    { workspace },
  );
  assert.equal(pending.state, 'pending');
  assert.equal(pending.command, args.cmd);
  const prepared = approvals.prepareAppApproval(
    pending.approval_id,
    { hostSession: 'chat-a' },
  );
  assert.equal(typeof prepared.approvalNonce, 'string');
  assert.throws(
    () => approvals.prepareAppApproval(
      pending.approval_id,
      { hostSession: 'chat-a' },
    ),
    /already bound/i,
  );
  const claimed = approvals.claimAppExecution(
    pending.approval_id,
    prepared.approvalNonce,
    'chat-a',
  );
  assert.equal(claimed.action.cmd, 'Write-Output APPROVED');
  assert.equal(claimed.action.workspace_handle, workspace.workspace_handle);
  assert.equal(claimed.action.workspace_root, workspace.workspace_root);

  const expiring = approvals.requestExecution(
    args,
    'approval-worker',
    { workspace },
  );
  now += 1001;
  assert.throws(
    () => approvals.prepareAppApproval(expiring.approval_id),
    /Unknown or expired/,
  );
});

test('ApprovalManager applies the configured TTL to workspace approvals', () => {
  let now = Date.UTC(2026, 8, 23, 12, 0, 0);
  const approvals = new ApprovalManager({
    ttlMs: 2000,
    now: () => now,
  });
  const pending = approvals.requestWorkspaceAction(
    'select_workspace',
    {
      environment_id: 'approval-worker',
      workspace_id: 'approval-workspace',
      workspace_root: 'C:\\workspace',
      create_if_missing: false,
    },
    'Enter workspace?',
  );

  now += 1999;
  assert.equal(
    approvals.getRequest(pending.approval_id).state,
    'pending',
  );

  now += 2;
  assert.throws(
    () => approvals.getRequest(pending.approval_id),
    /Unknown or expired/,
  );
});

test('ApprovalManager allows independent pending workspace approvals to coexist', () => {
  const approvals = new ApprovalManager();
  const first = approvals.requestWorkspaceAction(
    'select_workspace',
    {
      environment_id: 'approval-worker',
      workspace_id: 'project-a',
      workspace_root: 'C:\\projects\\project-a',
      create_if_missing: false,
    },
    'Enter project A?',
  );
  const second = approvals.requestWorkspaceAction(
    'select_workspace',
    {
      environment_id: 'approval-worker',
      workspace_id: 'project-b',
      workspace_root: 'C:\\projects\\project-b',
      create_if_missing: false,
    },
    'Enter project B?',
  );

  assert.notEqual(first.approval_id, second.approval_id);
  const firstPrepared = approvals.prepareAppApproval(
    first.approval_id,
    { hostSession: 'chat-a' },
  );
  const secondPrepared = approvals.prepareAppApproval(
    second.approval_id,
    { hostSession: 'chat-a' },
  );

  assert.equal(firstPrepared.request.workspace_id, 'project-a');
  assert.equal(secondPrepared.request.workspace_id, 'project-b');
  assert.equal(approvals.getRequest(first.approval_id).state, 'pending');
  assert.equal(approvals.getRequest(second.approval_id).state, 'pending');
  assert.throws(
    () => approvals.prepareAppApproval(first.approval_id, { hostSession: 'chat-a' }),
    /already bound/i,
  );
});

test('ApprovalManager app approvals require the card nonce and resume one frozen action', () => {
  const approvals = new ApprovalManager();
  const workspace = {
    workspace_handle: '00000000-0000-4000-8000-000000000001',
    environment_id: 'approval-worker',
    workspace_id: 'approval-workspace',
    workspace_kind: 'registered',
    workspace_root: 'C:\\workspace',
  };
  const pending = approvals.requestExecution(
    {
      workspace_handle: workspace.workspace_handle,
      cmd: 'Write-Output APP_APPROVED',
      yield_time_ms: 500,
      max_output_tokens: 1234,
      justification: 'Allow the frozen app action?',
    },
    'approval-worker',
    { workspace },
  );
  const prepared = approvals.prepareAppApproval(
    pending.approval_id,
    { hostSession: 'chat-session-a' },
  );

  assert.equal(prepared.request.state, 'pending');
  assert.equal(typeof prepared.request.operation_id, 'string');
  assert.equal(Object.hasOwn(prepared.request, 'approval_nonce'), false);
  assert.equal(typeof prepared.approvalNonce, 'string');
  assert.throws(
    () => approvals.claimAppExecution(
      prepared.request.approval_id,
      'wrong-secret',
      'chat-session-a',
    ),
    /nonce is invalid/i,
  );
  assert.throws(
    () => approvals.claimAppExecution(
      prepared.request.approval_id,
      prepared.approvalNonce,
      'chat-session-b',
    ),
    /different host session/i,
  );
  assert.throws(
    () => approvals.claimAppExecution(
      prepared.request.approval_id,
      prepared.approvalNonce,
    ),
    /different host session/i,
  );

  const claimed = approvals.claimAppExecution(
    prepared.request.approval_id,
    prepared.approvalNonce,
    'chat-session-a',
  );
  assert.equal(claimed.request.state, 'dispatching');
  assert.equal(claimed.action.cmd, 'Write-Output APP_APPROVED');
  assert.equal(claimed.action.workspace_id, 'approval-workspace');
  assert.equal(claimed.action.yield_time_ms, 500);
  assert.equal(claimed.action.max_output_tokens, 1234);

  const retryable = approvals.markAppExecutionRetryable(
    prepared.request.approval_id,
  );
  assert.equal(retryable.state, 'approved_retryable');
  const retried = approvals.claimAppExecution(
    prepared.request.approval_id,
    prepared.approvalNonce,
    'chat-session-a',
  );
  assert.equal(retried.request.state, 'dispatching');
  const consumed = approvals.markAppExecutionConsumed(
    prepared.request.approval_id,
  );
  assert.equal(consumed.state, 'consumed');
  assert.throws(
    () => approvals.claimAppExecution(
      prepared.request.approval_id,
      prepared.approvalNonce,
      'chat-session-a',
    ),
    /cannot dispatch from state=consumed/i,
  );
});

test('ApprovalManager does not expire an action while it is dispatching', () => {
  let now = Date.UTC(2026, 8, 23, 7, 0, 0);
  const approvals = new ApprovalManager({
    ttlMs: 1000,
    now: () => now,
  });
  const workspace = {
    workspace_handle: '00000000-0000-4000-8000-000000000001',
    environment_id: 'approval-worker',
    workspace_id: 'approval-workspace',
    workspace_kind: 'registered',
    workspace_root: 'C:\\workspace',
  };
  const pending = approvals.requestExecution(
    {
      workspace_handle: workspace.workspace_handle,
      cmd: 'Write-Output LONG_RUNNING',
    },
    'approval-worker',
    { workspace },
  );
  const prepared = approvals.prepareAppApproval(
    pending.approval_id,
  );
  approvals.claimAppExecution(
    prepared.request.approval_id,
    prepared.approvalNonce,
  );
  now += 2000;
  const consumed = approvals.markAppExecutionConsumed(
    prepared.request.approval_id,
  );
  assert.equal(consumed.state, 'consumed');
});

test('ApprovalManager terminal retention is independent of active approval TTL', () => {
  let now = Date.UTC(2026, 8, 23, 7, 0, 0);
  const approvals = new ApprovalManager({
    ttlMs: 60_000,
    terminalRetentionMs: 1000,
    now: () => now,
  });
  const args = {
    workspace_handle: '00000000-0000-4000-8000-000000000001',
    cmd: 'Write-Output TERMINAL_RETENTION',
  };
  const pending = approvals.requestExecution(args, 'approval-worker');
  const prepared = approvals.prepareAppApproval(pending.approval_id);
  approvals.denyAppExecution(
    pending.approval_id,
    prepared.approvalNonce,
  );

  now += 999;
  assert.equal(
    approvals.getRequest(pending.approval_id).state,
    'denied',
  );

  now += 2;
  assert.throws(
    () => approvals.getRequest(pending.approval_id),
    /Unknown or expired/,
  );
});

test('ApprovalManager freezes workspace creation permission into the pending action', () => {
  const approvals = new ApprovalManager();
  const intent = {
    environment_id: 'approval-worker',
    workspace_id: 'new-project',
    workspace_root: 'C:\\projects\\new-project',
    create_if_missing: true,
  };
  const pending = approvals.requestWorkspaceAction(
    'register_workspace',
    intent,
    'Create and register this workspace?',
  );
  assert.equal(pending.create_if_missing, true);
  const prepared = approvals.prepareAppApproval(
    pending.approval_id,
    { hostSession: 'chat-a' },
  );
  const claimed = approvals.claimAppWorkspace(
    pending.approval_id,
    prepared.approvalNonce,
    'chat-a',
  );
  assert.equal(claimed.action.operation, 'register_workspace');
  assert.equal(claimed.action.create_if_missing, true);
  assert.equal(claimed.action.workspace_root, intent.workspace_root);
});

test('ApprovalManager freezes deregistration identity and rejects reusable approval', () => {
  const approvals = new ApprovalManager();
  const target = {
    environment_id: 'worker',
    workspace_id: 'to-remove',
    workspace_root: 'C:\\projects\\to-remove',
    workspace_created_at: '2026-10-26T01:00:00.000Z',
  };
  const pending = approvals.requestWorkspaceAction(
    'unregister_workspace', target, 'Remove registration?',
  );
  assert.equal(pending.workspace_created_at, target.workspace_created_at);
  const { approvalNonce } = approvals.prepareAppApproval(pending.approval_id);
  assert.throws(
    () => approvals.claimAppWorkspace(pending.approval_id, 'invalid'),
    /nonce/,
  );
  const claimed = approvals.claimAppWorkspace(pending.approval_id, approvalNonce);
  assert.equal(claimed.action.operation, 'unregister_workspace');
  assert.equal(claimed.action.workspace_root, target.workspace_root);
  assert.equal(claimed.action.workspace_created_at, target.workspace_created_at);
  approvals.markAppWorkspaceConsumed(pending.approval_id);
  assert.throws(
    () => approvals.claimAppWorkspace(pending.approval_id, approvalNonce),
    /state=consumed/,
  );
});

test('ApprovalManager app workspace approvals require the card nonce and freeze the target', () => {
  const approvals = new ApprovalManager();
  const intent = {
    environment_id: 'approval-worker',
    workspace_id: 'project',
    workspace_root: 'C:\\projects\\project',
    create_if_missing: false,
  };
  const pending = approvals.requestWorkspaceAction(
    'select_workspace',
    intent,
    'Enter this workspace?',
  );
  const prepared = approvals.prepareAppApproval(
    pending.approval_id,
    { hostSession: 'chat-a' },
  );

  assert.equal(prepared.request.kind, 'workspace');
  assert.equal(prepared.request.operation, 'select_workspace');
  assert.equal(typeof prepared.approvalNonce, 'string');
  assert.throws(
    () => approvals.claimAppWorkspace(
      prepared.request.approval_id,
      'wrong-nonce',
      'chat-a',
    ),
    /nonce/i,
  );
  assert.throws(
    () => approvals.claimAppWorkspace(
      prepared.request.approval_id,
      prepared.approvalNonce,
      'chat-b',
    ),
    /different host session/i,
  );

  const claimed = approvals.claimAppWorkspace(
    prepared.request.approval_id,
    prepared.approvalNonce,
    'chat-a',
  );
  assert.deepEqual(claimed.action, {
    type: 'workspace',
    operation: 'select_workspace',
    ...intent,
  });
  const consumed = approvals.markAppWorkspaceConsumed(
    prepared.request.approval_id,
  );
  assert.equal(consumed.state, 'consumed');
  assert.throws(
    () => approvals.claimAppWorkspace(
      prepared.request.approval_id,
      prepared.approvalNonce,
      'chat-a',
    ),
    /state=consumed/,
  );
});

test('RemoteProcessManager executes only the frozen action after approval', async () => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  const args = {
    workspace_handle: '00000000-0000-4000-8000-000000000001',
    cmd: 'Write-Output ESCALATED_OK',
    sandbox_permissions: 'require_escalated',
    justification: 'Allow this command once?',
  };

  try {
    const pending = await manager.execCommand(args);
    assert.equal(pending.approval_required, true);
    assert.equal(workerHub.calls.length, 0);
    const prepared = approvalManager.prepareAppApproval(
      pending.approval_id,
      { hostSession: 'chat-a' },
    );
    const result = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve',
    }, { hostSession: 'chat-a' });
    assert.equal(result.state, 'consumed');
    assert.equal(workerHub.calls.length, 1);
    assert.equal(workerHub.calls[0].params.cmd, args.cmd);
    assert.equal(
      workerHub.calls[0].params.sandbox_permissions,
      'approved_escalated',
    );
    const changed = await manager.execCommand({
      ...args,
      cmd: 'Write-Output CHANGED',
    });
    assert.equal(changed.approval_required, true);
    assert.notEqual(changed.approval_id, pending.approval_id);
    assert.equal(workerHub.calls.length, 1);
    await assert.rejects(
      manager.resolvePendingExecution({
        approval_id: pending.approval_id,
        approval_nonce: prepared.approvalNonce,
        decision: 'approve',
      }, { hostSession: 'chat-a' }),
      /cannot dispatch from state=consumed/i,
    );
  } finally {
    await manager.close();
  }
});

test('RemoteProcessManager app approval executes only the frozen action', async () => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  try {
    const pending = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'Write-Output FROZEN_ACTION',
      workdir: '.',
      yield_time_ms: 250,
      sandbox_permissions: 'require_escalated',
      justification: 'Run the frozen test action?',
    });
    const prepared = approvalManager.prepareAppApproval(
      pending.approval_id,
      { hostSession: 'chat-a' },
    );
    assert.equal(prepared.request.state, 'pending');
    assert.equal(workerHub.calls.length, 0);

    const result = await manager.resolvePendingExecution({
      approval_id: prepared.request.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve',
    }, { hostSession: 'chat-a' });
    assert.equal(result.state, 'consumed');
    assert.equal(result.output, 'ESCALATED_OK');
    assert.equal(result.operation_id, prepared.request.operation_id);
    assert.equal(workerHub.calls.length, 1);
    assert.equal(workerHub.calls[0].method, 'exec_command');
    assert.equal(workerHub.calls[0].params.cmd, 'Write-Output FROZEN_ACTION');
    assert.equal(workerHub.calls[0].params.workspace_id, 'approval-workspace');
    assert.equal(
      workerHub.calls[0].params.sandbox_permissions,
      'approved_escalated',
    );
    assert.equal(Object.hasOwn(workerHub.calls[0].params, 'approval_id'), false);
    assert.equal(Object.hasOwn(workerHub.calls[0].params, 'justification'), false);
  } finally {
    await manager.close();
  }
});

test('RemoteProcessManager marks app approval unknown after an in-flight Worker failure', async () => {
  const environmentRegistry = restrictedRegistry();
  class RejectingWorkerHub extends EventEmitter {
    call() {
      return Promise.reject(new Error('worker disconnected after dispatch'));
    }
  }
  const approvalManager = new ApprovalManager();
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub: new RejectingWorkerHub(),
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  try {
    const pending = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'Write-Output MAYBE_STARTED',
      sandbox_permissions: 'require_escalated',
      justification: 'Run once?',
    });
    const prepared = approvalManager.prepareAppApproval(pending.approval_id);
    const result = await manager.resolvePendingExecution({
      approval_id: prepared.request.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve',
    });
    assert.equal(result.state, 'execution_unknown');
    assert.match(result.output, /will not retry automatically/i);
    await assert.rejects(
      manager.resolvePendingExecution({
        approval_id: prepared.request.approval_id,
        approval_nonce: prepared.approvalNonce,
        decision: 'approve',
      }),
      /cannot dispatch from state=execution_unknown/i,
    );
  } finally {
    await manager.close();
  }
});

test('App approval remains retryable when Worker dispatch fails before send', async () => {
  const environmentRegistry = restrictedRegistry();
  class PreDispatchWorkerHub extends EventEmitter {
    constructor() {
      super();
      this.failBeforeSend = true;
      this.calls = [];
    }

    call(environmentId, method, params) {
      if (this.failBeforeSend) {
        throw new Error('no connected worker before send');
      }
      this.calls.push({ environmentId, method, params });
      return Promise.resolve({
        chunk_id: 'app-retry',
        wall_time_seconds: 0,
        output: 'APP_RETRY_OK',
        exit_code: 0,
      });
    }
  }
  const workerHub = new PreDispatchWorkerHub();
  const approvalManager = new ApprovalManager();
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  const args = {
    workspace_handle: '00000000-0000-4000-8000-000000000001',
    cmd: 'Write-Output APP_RETRY_OK',
    sandbox_permissions: 'require_escalated',
    justification: 'Retryable dispatch test?',
  };
  try {
    const pending = await manager.execCommand(args);
    const prepared = approvalManager.prepareAppApproval(pending.approval_id);
    const failed = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve',
    });
    assert.equal(failed.state, 'approved_retryable');
    assert.match(failed.output, /before send/i);
    workerHub.failBeforeSend = false;
    const retried = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve',
    });
    assert.equal(retried.output, 'APP_RETRY_OK');
    assert.equal(retried.state, 'consumed');
    assert.equal(workerHub.calls.length, 1);
  } finally {
    await manager.close();
  }
});

test('Worker sandbox policy maps an approved escalation to full-access', () => {
  const environment = restrictedRegistry().resolve('approval-worker');
  assert.equal(
    resolvePermissionProfile(environment, 'approved_escalated'),
    'full-access',
  );
});

test('RemoteProcessManager applies native Codex Allow rules to remote Git', async (t) => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const codexPolicy = testCodexPolicy(t, [['git', 'push']]);
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    codexPolicy,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });

  try {
    const result = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'git push origin main',
      sandbox_permissions: 'require_escalated',
      justification: 'Caller requested escalation.',
    });
    assert.equal(result.approval_required, undefined);
    assert.equal(result.exit_code, 0);
    assert.equal(workerHub.calls.length, 1);
    assert.equal(workerHub.calls[0].params.sandbox_permissions, 'approved_escalated');
    assert.equal(result.policy_auto_approved, true);
    assert.deepEqual(result.policy_prefix_tokens, ['git', 'push']);
    assert.equal(Object.hasOwn(workerHub.calls[0].params, 'approval_id'), false);
    assert.equal(Object.hasOwn(workerHub.calls[0].params, 'justification'), false);
  } finally {
    await manager.close();
  }
});

test('RemoteProcessManager runs node --test through native Codex ExecPolicy', async (t) => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const codexPolicy = testCodexPolicy(t, [['node', '--test']]);
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    codexPolicy,
    approvalManager: {
      requestExecution() {
        throw new Error('approval must not be requested');
      },
    },
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  try {
    const result = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'node --test test/approval.test.mjs',
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.policy_auto_approved, true);
    assert.deepEqual(result.policy_prefix_tokens, ['node', '--test']);
    assert.equal(workerHub.calls.length, 1);
    assert.equal(
      workerHub.calls[0].params.sandbox_permissions,
      'approved_escalated',
    );
  } finally {
    await manager.close();
  }
});

test('native Codex command prefixes are consistent across shell choices', async (t) => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const codexPolicy = testCodexPolicy(t, [['node', '--test']]);
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    codexPolicy,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  try {
    const result = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'node --test test/approval.test.mjs',
      shell: 'cmd.exe',
    });
    assert.equal(result.policy_auto_approved, true);
    assert.equal(workerHub.calls.length, 1);
    assert.equal(workerHub.calls[0].params.sandbox_permissions, 'approved_escalated');
  } finally {
    await manager.close();
  }
});

test('native Codex policy authorizes the exact pinned Tailscale executable', async (t) => {
  const workerHub = new FakeWorkerHub();
  const executable = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  const codexPolicy = testCodexPolicy(t, [[executable]]);
  const manager = new RemoteProcessManager({
    environmentRegistry: restrictedRegistry(), workerHub, codexPolicy,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  try {
    const result = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: '"' + executable + '" version', shell: 'cmd.exe',
    });
    assert.equal(result.policy_auto_approved, true);
    assert.deepEqual(result.policy_prefix_tokens, [executable]);
    assert.equal(workerHub.calls[0].params.sandbox_permissions, 'approved_escalated');
    assert.equal(workerHub.calls[0].params.cmd, '"' + executable + '" version');
  } finally { await manager.close(); }
});

test('a pinned Tailscale path rule does not authorize a bare alias or mixed command', async (t) => {
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const executable = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  const codexPolicy = testCodexPolicy(t, [[executable]]);
  const manager = new RemoteProcessManager({
    environmentRegistry: restrictedRegistry(), workerHub, approvalManager, codexPolicy,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  try {
    const alias = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'tailscale.exe status', shell: 'cmd.exe',
    });
    assert.equal(alias.policy_auto_approved, undefined);
    assert.equal(workerHub.calls.at(-1).params.sandbox_permissions, undefined);
    const mixed = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: '"' + executable + '" status && echo probe', shell: 'cmd.exe',
      sandbox_permissions: 'require_escalated',
    });
    assert.equal(mixed.approval_required, true);
    assert.equal(workerHub.calls.at(-1).params.cmd, 'tailscale.exe status');
  } finally { await manager.close(); }
});
test('approval persists a native Codex prefix rule and ordinary calls reuse it', async (t) => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const codexPolicy = testCodexPolicy(t);
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
    codexPolicy,
  });
  const args = {
    workspace_handle: '00000000-0000-4000-8000-000000000001',
    cmd: 'wsl.exe --status',
    sandbox_permissions: 'require_escalated',
    prefix_rule: ['wsl.exe'],
    justification: 'Always allow WSL?',
  };

  try {
    const pending = await manager.execCommand(args);
    assert.equal(pending.state, 'pending');
    assert.deepEqual(pending.prefix_rule, ['wsl.exe']);
    assert.equal(pending.policy_persistable, true);
    const prepared = approvalManager.prepareAppApproval(pending.approval_id);

    const resolved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve_always',
    });
    assert.equal(resolved.state, 'consumed');
    assert.equal(resolved.policy_saved, true);
    assert.equal(codexPolicy.matchSegment({ tokens: ['wsl.exe', '--status'] }).decision, 'allow');
    assert.equal(workerHub.calls.length, 1);
    assert.equal(
      workerHub.calls[0].params.sandbox_permissions,
      'approved_escalated',
    );

    const automatic = await manager.execCommand({
      workspace_handle: args.workspace_handle,
      cmd: 'wsl.exe --help',
    });
    assert.equal(automatic.policy_auto_approved, true);
    assert.match(automatic.policy_rule_id, /^[a-f0-9]{16}$/);
    assert.equal(workerHub.calls.length, 2);
    assert.equal(
      workerHub.calls[1].params.sandbox_permissions,
      'approved_escalated',
    );
    assert.deepEqual(automatic.policy_prefix_tokens, ['wsl.exe']);
  } finally {
    await manager.close();
  }
});

test('one native Always allow rule auto-authorizes both Workers and mixed command sequences', async (t) => {
  const registry = restrictedRegistry();
  registry.register({
    id: 'second-worker',
    platform: 'windows',
    cwd: 'C:\\second-workspace',
    workspaceRoots: ['C:\\second-workspace'],
    permissionProfile: 'workspace-write',
    backend: 'remote-worker',
  });
  const first = '00000000-0000-4000-8000-000000000001';
  const second = '00000000-0000-4000-8000-000000000002';
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const codexPolicy = testCodexPolicy(t);
  const manager = new RemoteProcessManager({
    environmentRegistry: registry,
    workerHub,
    approvalManager,
    codexPolicy,
    workspaceHandleManager: {
      resolve(handleId) {
        return {
          workspace_handle: handleId,
          environment_id: handleId === first ? 'approval-worker' : 'second-worker',
          workspace_id: handleId === first ? 'project-one' : 'project-two',
          workspace_root: handleId === first ? 'C:\\workspace' : 'C:\\second-workspace',
          workspace_kind: 'registered',
        };
      },
    },
  });
  try {
    const pending = await manager.execCommand({
      workspace_handle: first,
      cmd: 'wsl.exe --status',
      sandbox_permissions: 'require_escalated',
      prefix_rule: ['wsl.exe'],
    });
    assert.equal(pending.approval_required, true);
    const frozen = approvalManager.prepareAppApproval(pending.approval_id);
    const saved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: frozen.approvalNonce,
      decision: 'approve_always',
    });
    assert.equal(saved.policy_saved, true);
    assert.equal(codexPolicy.matchSegment({ tokens: ['wsl.exe', '--status'] }).decision, 'allow');
    assert.match(fs.readFileSync(codexPolicy.stateFile, 'utf8'), /prefix_rule/);
    assert.doesNotMatch(fs.readFileSync(codexPolicy.stateFile, 'utf8'), /workspace_id/);

    const result = await manager.execCommand({
      workspace_handle: second,
      cmd: 'wsl.exe --status && wsl.exe --help',
      workdir: 'different-dir',
      shell: 'cmd.exe',
      tty: true,
    });
    assert.equal(result.policy_auto_approved, true);
    assert.equal(workerHub.calls.at(-1).environmentId, 'second-worker');
    assert.equal(workerHub.calls.at(-1).params.sandbox_permissions, 'approved_escalated');

    const unmatched = await manager.execCommand({
      workspace_handle: second,
      cmd: 'wsl.exe --status && whoami',
    });
    assert.equal(unmatched.policy_auto_approved, undefined);
    assert.equal(workerHub.calls.at(-1).params.sandbox_permissions, undefined);
  } finally {
    await manager.close();
  }
});

test('invalid explicit prefix_rule is rejected before approval creation', async () => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  let approvals = 0;
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager: {
      requestExecution() {
        approvals += 1;
        throw new Error('must not create approval');
      },
    },
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  try {
    await assert.rejects(
      manager.execCommand({
        workspace_handle: '00000000-0000-4000-8000-000000000001',
        cmd: 'wsl.exe --status',
        sandbox_permissions: 'require_escalated',
        prefix_rule: ['git'],
      }),
      /match at least one executable segment/i,
    );
    assert.equal(approvals, 0);
    assert.equal(workerHub.calls.length, 0);
  } finally {
    await manager.close();
  }
});

test('compound command without explicit prefix is not persistable', async () => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  try {
    const pending = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'Write-Output ONE; Write-Output TWO',
      sandbox_permissions: 'require_escalated',
    });
    assert.equal(pending.policy_persistable, false);
    assert.equal(pending.prefix_rule, null);
  } finally {
    await manager.close();
  }
});

test('repeated identical compound segments save and reuse one native prefix', async (t) => {
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const codexPolicy = testCodexPolicy(t);
  const manager = new RemoteProcessManager({
    environmentRegistry: restrictedRegistry(),
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
    codexPolicy,
  });
  const workspace_handle = '00000000-0000-4000-8000-000000000001';
  try {
    const pending = await manager.execCommand({
      workspace_handle,
      cmd: 'git status --short; git status --short',
      sandbox_permissions: 'require_escalated',
    });
    assert.equal(pending.policy_persistable, true);
    assert.deepEqual(pending.prefix_rule, ['git', 'status', '--short']);
    const explicit = await manager.execCommand({
      workspace_handle,
      cmd: 'git status --short && git status --short',
      sandbox_permissions: 'require_escalated',
      prefix_rule: ['git', 'status'],
    });
    assert.equal(explicit.policy_persistable, true);
    assert.deepEqual(explicit.prefix_rule, ['git', 'status']);

    const frozen = approvalManager.prepareAppApproval(pending.approval_id);
    const saved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: frozen.approvalNonce,
      decision: 'approve_always',
    });
    assert.equal(saved.policy_saved, true);
    const automatic = await manager.execCommand({
      workspace_handle,
      cmd: 'git status --short && git status --short',
    });
    assert.equal(automatic.policy_auto_approved, true);
    assert.equal(codexPolicy.matchSegment({
      tokens: ['git', 'status', '--short'],
    }).decision, 'allow');
  } finally {
    await manager.close();
  }
});

test('a partially allowed compound proposes the sole missing native command prefix', async (t) => {
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const codexPolicy = testCodexPolicy(t, [['git', 'status', '--short']]);
  const manager = new RemoteProcessManager({
    environmentRegistry: restrictedRegistry(),
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
    codexPolicy,
  });
  const workspace_handle = '00000000-0000-4000-8000-000000000001';
  const cmd = 'git status --short && git log -1';
  try {
    const pending = await manager.execCommand({
      workspace_handle,
      cmd,
      sandbox_permissions: 'require_escalated',
    });
    assert.equal(pending.policy_persistable, true);
    assert.deepEqual(pending.prefix_rule, ['git', 'log', '-1']);
    const frozen = approvalManager.prepareAppApproval(pending.approval_id);
    const saved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: frozen.approvalNonce,
      decision: 'approve_always',
    });
    assert.equal(saved.policy_saved, true);
    const automatic = await manager.execCommand({ workspace_handle, cmd });
    assert.equal(automatic.policy_auto_approved, true);
    assert.equal(codexPolicy.matchSegment({ tokens: ['git', 'log', '-1'] }).decision, 'allow');
  } finally {
    await manager.close();
  }
});

test('escalated compound command is allowed only when every native segment matches', async (t) => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const codexPolicy = testCodexPolicy(t, [['git', 'fetch'], ['wsl.exe']]);
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager: {
      requestExecution() {
        throw new Error('approval must not be requested');
      },
    },
    workspaceHandleManager: fakeWorkspaceHandleManager(),
    codexPolicy,
  });
  try {
    const result = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'git fetch origin && wsl.exe --status',
      sandbox_permissions: 'require_escalated',
    });
    assert.equal(result.policy_auto_approved, true);
    assert.equal(result.policy_rule_ids.length, 2);
    assert.equal(workerHub.calls.length, 1);
    assert.equal(
      workerHub.calls[0].params.sandbox_permissions,
      'approved_escalated',
    );
  } finally {
    await manager.close();
  }
});

test('native policy does not implicitly allow an unmatched Git segment on Linux', async (t) => {
  const environmentRegistry = new EnvironmentRegistry({ resolvePaths: false });
  environmentRegistry.register({
    id: 'approval-worker',
    platform: 'linux',
    cwd: '/workspace',
    workspaceRoots: ['/workspace'],
    permissionProfile: 'workspace-write',
    backend: 'remote-worker',
  });
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const codexPolicy = testCodexPolicy(t, [['echo']]);
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceHandleManager: {
      resolve(handleId) {
        return {
          workspace_handle: handleId,
          environment_id: 'approval-worker',
          workspace_id: 'approval-workspace',
          workspace_kind: 'registered',
          workspace_root: '/workspace',
        };
      },
    },
    codexPolicy,
  });
  try {
    const result = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'git fetch origin && echo ok',
      sandbox_permissions: 'require_escalated',
    });
    assert.equal(result.approval_required, true);
    assert.equal(result.state, 'pending');
    assert.equal(workerHub.calls.length, 0);
  } finally {
    await manager.close();
  }
});

test('native Prompt requests approval while Forbidden rejects before dispatch', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-codex-decisions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'default.rules');
  fs.writeFileSync(stateFile, [
    'prefix_rule(pattern=["needs-review"], decision="prompt")',
    'prefix_rule(pattern=["blocked-command"], decision="forbidden")',
    '',
  ].join('\n'));
  const codexPolicy = new CodexExecPolicy({ stateFile });
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const manager = new RemoteProcessManager({
    environmentRegistry: restrictedRegistry(),
    workerHub,
    approvalManager,
    codexPolicy,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
  });
  try {
    const prompt = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'needs-review --run',
    });
    assert.equal(prompt.approval_required, true);
    assert.equal(workerHub.calls.length, 0);

    await assert.rejects(manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'blocked-command --run',
    }), /Native Codex ExecPolicy forbids/);
    assert.equal(workerHub.calls.length, 0);

    const prepared = approvalManager.prepareAppApproval(prompt.approval_id);
    const approved = await manager.resolvePendingExecution({
      approval_id: prompt.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve',
    });
    assert.equal(approved.state, 'consumed');
    assert.equal(workerHub.calls.length, 1);
    assert.equal(workerHub.calls[0].params.cmd, 'needs-review --run');
  } finally {
    await manager.close();
  }
});

test('post-dispatch native policy save failure is surfaced without redispatch', async () => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const codexPolicy = {
    match() {
      return null;
    },
    allow() {
      throw new Error('disk full while saving policy');
    },
  };
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
    codexPolicy,
  });
  try {
    const pending = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'wsl.exe --status',
      sandbox_permissions: 'require_escalated',
      prefix_rule: ['wsl.exe'],
    });
    const prepared = approvalManager.prepareAppApproval(pending.approval_id);
    const resolved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve_always',
    });
    assert.equal(resolved.state, 'consumed');
    assert.equal(resolved.policy_save_failed, true);
    assert.match(resolved.policy_save_error, /disk full/);
    assert.equal(workerHub.calls.length, 1);
    assert.throws(
      () => approvalManager.claimAppExecution(
        pending.approval_id,
        prepared.approvalNonce,
      ),
      /consumed|already/i,
    );
  } finally {
    await manager.close();
  }
});

test('Always allow saves a native global npm prefix without package-script hash probing', async () => {
  const environmentRegistry = restrictedRegistry();
  const approvalManager = new ApprovalManager();
  const calls = [];
  const workerHub = new EventEmitter();
  workerHub.call = async function call(environmentId, method, params) {
      calls.push({ environmentId, method, params });
      return {
        chunk_id: 'exec',
        wall_time_seconds: 0.01,
        output: 'TEST_OK',
        exit_code: 0,
      };
  };
  let savedPrefix = null;
  const codexPolicy = {
    match() { return null; },
    allow({ prefixTokens }) {
      savedPrefix = prefixTokens;
      return {
        rule_id: '22222222-2222-4222-8222-222222222222',
        prefix_tokens: prefixTokens,
      };
    },
  };
  const trustedPackageScriptStore = {
    mayMatch() {
      return false;
    },
    trust() {
      throw new Error('The approval must save a generic allow prefix');
    },
  };
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
    codexPolicy,
    trustedPackageScriptStore,
  });

  try {
    const pending = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'npm test',
      sandbox_permissions: 'require_escalated',
      justification: 'Persist npm test?',
    });
    const prepared = approvalManager.prepareAppApproval(pending.approval_id);
    const resolved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve_always',
    });
    assert.equal(resolved.state, 'consumed');
    assert.equal(resolved.policy_saved, true);
    assert.equal(resolved.trusted_package_script, undefined);
    assert.deepEqual(savedPrefix, ['npm', 'test']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.sandbox_permissions, 'approved_escalated');
  } finally {
    await manager.close();
  }
});

test('Always allow npm does not require package-script probing even if command fails', async () => {
  const environmentRegistry = restrictedRegistry();
  const approvalManager = new ApprovalManager();
  const calls = [];
  const workerHub = new EventEmitter();
  workerHub.call = async function call(environmentId, method, params) {
      calls.push({ environmentId, method, params });
      return {
        chunk_id: 'probe',
        wall_time_seconds: 0.01,
        output: '',
        exit_code: 42,
      };
  };
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceHandleManager: fakeWorkspaceHandleManager(),
    codexPolicy: {
      match() { return null; },
      allow({ prefixTokens }) {
        return { rule_id: '33333333-3333-4333-8333-333333333333', prefix_tokens: prefixTokens };
      },
    },
    trustedPackageScriptStore: {
      mayMatch() {
        return false;
      },
      trust() {
        throw new Error('must not save');
      },
    },
  });

  try {
    const pending = await manager.execCommand({
      workspace_handle: '00000000-0000-4000-8000-000000000001',
      cmd: 'npm test',
      sandbox_permissions: 'require_escalated',
      justification: 'Persist npm test?',
    });
    const prepared = approvalManager.prepareAppApproval(pending.approval_id);
    const resolved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve_always',
    });
    assert.equal(resolved.state, 'consumed');
    assert.equal(resolved.policy_saved, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.sandbox_permissions, 'approved_escalated');
  } finally {
    await manager.close();
  }
});
