import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ApprovalManager } from '../src/controller/approval-manager.mjs';
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

test('ApprovalManager binds a grant to one exact execution and expires it', () => {
  let now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const approvals = new ApprovalManager({
    ttlMs: 1000,
    now: () => now,
  });
  const args = {
    cmd: 'Write-Output APPROVED',
    workdir: 'C:\\workspace',
    tty: false,
    shell: 'powershell.exe',
    justification: 'Allow this test once?',
  };

  const pending = approvals.requestExecution(args, 'approval-worker');
  assert.equal(pending.state, 'pending');
  assert.equal(pending.command, args.cmd);

  const approved = approvals.respond(pending.approval_id, 'approve');
  assert.equal(approved.state, 'approved');

  assert.throws(
    () => approvals.consumeExecution(
      pending.approval_id,
      { ...args, cmd: 'Write-Output CHANGED' },
      'approval-worker',
    ),
    /does not match/,
  );

  const consumed = approvals.consumeExecution(
    pending.approval_id,
    args,
    'approval-worker',
  );
  assert.equal(consumed.state, 'consumed');
  assert.throws(
    () => approvals.consumeExecution(
      pending.approval_id,
      args,
      'approval-worker',
    ),
    /not approved/,
  );

  const expiring = approvals.requestExecution(args, 'approval-worker');
  now += 1001;
  assert.throws(
    () => approvals.respond(expiring.approval_id, 'approve'),
    /Unknown or expired/,
  );
});

test('RemoteProcessManager executes only after one matching approval', async () => {
  const environmentRegistry = restrictedRegistry();
  const workerHub = new FakeWorkerHub();
  const approvalManager = new ApprovalManager();
  const manager = new RemoteProcessManager({
    environmentRegistry,
    workerHub,
    approvalManager,
  });
  const args = {
    environment_id: 'approval-worker',
    cmd: 'Write-Output ESCALATED_OK',
    sandbox_permissions: 'require_escalated',
    justification: 'Allow this command once?',
  };

  try {
    const pending = await manager.execCommand(args);
    assert.equal(pending.approval_required, true);
    assert.equal(workerHub.calls.length, 0);

    approvalManager.respond(pending.approval_id, 'approve');

    await assert.rejects(
      manager.execCommand({
        ...args,
        approval_id: pending.approval_id,
        cmd: 'Write-Output CHANGED',
      }),
      /does not match/,
    );
    assert.equal(workerHub.calls.length, 0);

    const result = await manager.execCommand({
      ...args,
      approval_id: pending.approval_id,
    });
    assert.equal(result.exit_code, 0);
    assert.equal(workerHub.calls.length, 1);
    assert.equal(
      workerHub.calls[0].params.sandbox_permissions,
      'approved_escalated',
    );
    assert.equal(
      Object.hasOwn(workerHub.calls[0].params, 'approval_id'),
      false,
    );

    await assert.rejects(
      manager.execCommand({
        ...args,
        approval_id: pending.approval_id,
      }),
      /not approved/,
    );
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
  });

  try {
    const result = await manager.execCommand({
      environment_id: 'approval-worker',
      cmd: 'git push origin main',
      sandbox_permissions: 'require_escalated',
      justification: 'Legacy caller requested escalation.',
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
