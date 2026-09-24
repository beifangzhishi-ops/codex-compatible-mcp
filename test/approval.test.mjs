import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  ApprovalManager,
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_TERMINAL_RETENTION_MS,
} from '../src/controller/approval-manager.mjs';
import { hashPackageScript } from '../src/controller/exec-policy-store.mjs';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';
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

test('ApprovalManager defaults to a 15-minute approval lifetime', () => {
  assert.equal(DEFAULT_APPROVAL_TTL_MS, 15 * 60 * 1000);
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

function fakeWorkspaceContextManager() {
  return {
    resolve(contextId) {
      assert.equal(contextId, '00000000-0000-4000-8000-000000000001');
      return {
        workspace_context: contextId,
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
    workspace_context: '00000000-0000-4000-8000-000000000001',
    workspace_id: 'approval-workspace',
    workspace_kind: 'registered',
    workspace_root: 'C:\\workspace',
  };
  const args = {
    workspace_context: workspace.workspace_context,
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
  assert.equal(claimed.action.workspace_context, workspace.workspace_context);
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

test('ApprovalManager app approvals require the card nonce and resume one frozen action', () => {
  const approvals = new ApprovalManager();
  const workspace = {
    workspace_context: '00000000-0000-4000-8000-000000000001',
    environment_id: 'approval-worker',
    workspace_id: 'approval-workspace',
    workspace_kind: 'registered',
    workspace_root: 'C:\\workspace',
  };
  const pending = approvals.requestExecution(
    {
      workspace_context: workspace.workspace_context,
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
    workspace_context: '00000000-0000-4000-8000-000000000001',
    environment_id: 'approval-worker',
    workspace_id: 'approval-workspace',
    workspace_kind: 'registered',
    workspace_root: 'C:\\workspace',
  };
  const pending = approvals.requestExecution(
    {
      workspace_context: workspace.workspace_context,
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
    workspace_context: '00000000-0000-4000-8000-000000000001',
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
    workspaceContextManager: fakeWorkspaceContextManager(),
  });
  const args = {
    workspace_context: '00000000-0000-4000-8000-000000000001',
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
    workspaceContextManager: fakeWorkspaceContextManager(),
  });
  try {
    const pending = await manager.execCommand({
      workspace_context: '00000000-0000-4000-8000-000000000001',
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
    workspaceContextManager: fakeWorkspaceContextManager(),
  });
  try {
    const pending = await manager.execCommand({
      workspace_context: '00000000-0000-4000-8000-000000000001',
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
    workspaceContextManager: fakeWorkspaceContextManager(),
  });
  const args = {
    workspace_context: '00000000-0000-4000-8000-000000000001',
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

test('RemoteProcessManager does not request approval for trusted remote Git', async () => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceContextManager: fakeWorkspaceContextManager(),
  });

  try {
    const result = await manager.execCommand({
      workspace_context: '00000000-0000-4000-8000-000000000001',
      cmd: 'git push origin main',
      sandbox_permissions: 'require_escalated',
      justification: 'Caller requested escalation.',
    });
    assert.equal(result.approval_required, undefined);
    assert.equal(result.exit_code, 0);
    assert.equal(workerHub.calls.length, 1);
    assert.equal(workerHub.calls[0].params.sandbox_permissions, 'use_default');
    assert.equal(Object.hasOwn(workerHub.calls[0].params, 'approval_id'), false);
    assert.equal(Object.hasOwn(workerHub.calls[0].params, 'justification'), false);
  } finally {
    await manager.close();
  }
});

test('approval can persist a workspace execution policy and reuse it', async () => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  let allowed = false;
  const execPolicyStore = {
    match({ args }) {
      if (!allowed || args.cmd !== 'Write-Output POLICY_OK') return null;
      return {
        rule_id: '11111111-1111-4111-8111-111111111111',
        decision: 'allow',
      };
    },
    allow({ args }) {
      assert.equal(args.cmd, 'Write-Output POLICY_OK');
      allowed = true;
      return {
        rule_id: '11111111-1111-4111-8111-111111111111',
        decision: 'allow',
      };
    },
  };
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceContextManager: fakeWorkspaceContextManager(),
    execPolicyStore,
  });
  const args = {
    workspace_context: '00000000-0000-4000-8000-000000000001',
    cmd: 'Write-Output POLICY_OK',
    sandbox_permissions: 'require_escalated',
    justification: 'Allow this debugging command?',
  };

  try {
    const pending = await manager.execCommand(args);
    assert.equal(pending.state, 'pending');
    const prepared = approvalManager.prepareAppApproval(pending.approval_id);

    const resolved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve_workspace',
    });
    assert.equal(resolved.state, 'consumed');
    assert.equal(resolved.policy_saved, true);
    assert.equal(allowed, true);
    assert.equal(workerHub.calls.length, 1);
    assert.equal(
      workerHub.calls[0].params.sandbox_permissions,
      'approved_escalated',
    );

    const automatic = await manager.execCommand(args);
    assert.equal(automatic.policy_auto_approved, true);
    assert.equal(
      automatic.policy_rule_id,
      '11111111-1111-4111-8111-111111111111',
    );
    assert.equal(workerHub.calls.length, 2);
    assert.equal(
      workerHub.calls[1].params.sandbox_permissions,
      'approved_escalated',
    );
  } finally {
    await manager.close();
  }
});

test('package-script workspace approval uses a restricted-sandbox-safe policy probe', async () => {
  const environmentRegistry = restrictedRegistry();
  const approvalManager = new ApprovalManager();
  const calls = [];
  const workerHub = new EventEmitter();
  workerHub.call = async function call(environmentId, method, params) {
      calls.push({ environmentId, method, params });
      if (params.sandbox_permissions === 'use_default') {
        assert.match(params.cmd, /ConvertTo-Json -Compress/);
        assert.doesNotMatch(params.cmd, /ToBase64String|Text\.Encoding/);
        return {
          chunk_id: 'probe',
          wall_time_seconds: 0.01,
          output: '"node --test"\r\n',
          exit_code: 0,
        };
      }
      return {
        chunk_id: 'exec',
        wall_time_seconds: 0.01,
        output: 'TEST_OK',
        exit_code: 0,
      };
  };
  let allowedPackageScript = null;
  const execPolicyStore = {
    match() {
      return null;
    },
    allow({ packageScript }) {
      allowedPackageScript = packageScript;
      return {
        rule_id: '22222222-2222-4222-8222-222222222222',
        decision: 'allow',
      };
    },
  };
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
    workspaceContextManager: fakeWorkspaceContextManager(),
    execPolicyStore,
  });

  try {
    const pending = await manager.execCommand({
      workspace_context: '00000000-0000-4000-8000-000000000001',
      cmd: 'npm test',
      sandbox_permissions: 'require_escalated',
      justification: 'Persist npm test?',
    });
    const prepared = approvalManager.prepareAppApproval(pending.approval_id);
    const resolved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve_workspace',
    });
    assert.equal(resolved.state, 'consumed');
    assert.equal(resolved.policy_saved, true);
    assert.deepEqual(allowedPackageScript, {
      package_manager: 'npm',
      script: 'test',
      script_sha256: hashPackageScript('node --test'),
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].params.sandbox_permissions, 'use_default');
    assert.equal(calls[1].params.sandbox_permissions, 'use_default');
    assert.equal(calls[2].params.sandbox_permissions, 'approved_escalated');
  } finally {
    await manager.close();
  }
});

test('package-script probe failure stays retryable without dispatching', async () => {
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
    workspaceContextManager: fakeWorkspaceContextManager(),
    execPolicyStore: {
      match() {
        return null;
      },
      allow() {
        throw new Error('must not save');
      },
    },
  });

  try {
    const pending = await manager.execCommand({
      workspace_context: '00000000-0000-4000-8000-000000000001',
      cmd: 'npm test',
      sandbox_permissions: 'require_escalated',
      justification: 'Persist npm test?',
    });
    const prepared = approvalManager.prepareAppApproval(pending.approval_id);
    const resolved = await manager.resolvePendingExecution({
      approval_id: pending.approval_id,
      approval_nonce: prepared.approvalNonce,
      decision: 'approve_workspace',
    });
    assert.equal(resolved.state, 'approved_retryable');
    assert.match(resolved.output, /Could not resolve package\.json script "test"/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].params.sandbox_permissions, 'use_default');
    assert.equal(calls[1].params.sandbox_permissions, 'use_default');
  } finally {
    await manager.close();
  }
});
