import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApprovalManager } from '../src/controller/approval-manager.mjs';
import { ApprovalReceiptStore } from '../src/controller/approval-receipt-store.mjs';

test('authenticated terminal receipt survives Controller restart and active Map expiry', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-approval-receipt-'));
  const file = path.join(dir, 'receipts.json');
  let time = 10000;
  try {
    const store = new ApprovalReceiptStore({ stateFile: file, now: () => time });
    const manager = new ApprovalManager({
      now: () => time, terminalRetentionMs: 100, receiptStore: store,
    });
    const pending = manager.requestWorkspaceAction('register_workspace', {
      environment_id: 'worker', workspace_id: 'project', workspace_root: 'C:\\project',
    });
    const { approvalNonce } = manager.prepareAppApproval(pending.approval_id, {
      hostSession: 'conversation-a',
    });
    manager.claimAppWorkspace(pending.approval_id, approvalNonce, 'conversation-a');
    const consumed = manager.markAppWorkspaceConsumed(pending.approval_id);
    const key = '00000000-0000-4000-8000-000000000099';
    manager.recordAppOutcome(pending.approval_id, {
      ...consumed, workspace_context: key, workspace_kind: 'registered',
    });
    assert.equal(manager.readAppStatus(pending.approval_id, approvalNonce, {
      hostSession: 'conversation-a',
    }).workspace_context, key);

    time += 200;
    const recovered = new ApprovalManager({
      now: () => time,
      receiptStore: new ApprovalReceiptStore({ stateFile: file, now: () => time }),
    });
    const status = recovered.readAppStatus(pending.approval_id, approvalNonce, {
      hostSession: 'conversation-a',
    });
    assert.equal(status.state, 'consumed');
    assert.equal(status.workspace_context, key);
    assert.equal(status.approval_required, false);
    assert.equal(status.operation, 'register_workspace');
    assert.equal(Object.hasOwn(status, 'nonce_hash'), false);
    assert.throws(() => recovered.readAppStatus(pending.approval_id, 'wrong-nonce', {
      hostSession: 'conversation-a',
    }), /capability is invalid/i);
    assert.throws(() => recovered.readAppStatus(pending.approval_id, approvalNonce, {
      hostSession: 'conversation-b',
    }), /capability is invalid/i);
    assert.throws(() => recovered.getRequest(pending.approval_id), /Unknown or expired/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('terminal receipts never publish a Key for failures, unregister or execution', async () => {
  const manager = new ApprovalManager({ receiptStore: new ApprovalReceiptStore() });
  for (const operation of ['select_workspace', 'unregister_workspace']) {
    const pending = manager.requestWorkspaceAction(operation, {
      environment_id: 'worker', workspace_id: 'project', workspace_root: 'C:\\project',
    });
    const { approvalNonce } = manager.prepareAppApproval(pending.approval_id);
    manager.claimAppWorkspace(pending.approval_id, approvalNonce);
    const consumed = manager.markAppWorkspaceConsumed(pending.approval_id);
    manager.recordAppOutcome(pending.approval_id, {
      ...consumed, action_failed: operation === 'select_workspace',
      workspace_context: '00000000-0000-4000-8000-000000000099',
      workspace_kind: 'registered',
    });
    assert.equal(manager.readAppStatus(pending.approval_id, approvalNonce).workspace_context, undefined);
  }
});

test('receipt storage expires records and bounds total count', () => {
  let time = 10000;
  const receipts = new ApprovalReceiptStore({
    now: () => time, retentionMs: 100, maxReceipts: 2,
  });
  const manager = new ApprovalManager({ now: () => time, receiptStore: receipts });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const pending = manager.requestWorkspaceAction('select_workspace', {
      environment_id: 'worker', workspace_id: String(i), workspace_root: 'C:\\project',
    });
    const { approvalNonce } = manager.prepareAppApproval(pending.approval_id);
    const denied = manager.denyAppWorkspace(pending.approval_id, approvalNonce);
    manager.recordAppOutcome(pending.approval_id, denied);
    ids.push({ id: pending.approval_id, nonce: approvalNonce });
    time += 1;
  }
  assert.equal(receipts.read(ids[0].id, ids[0].nonce, null), null);
  assert.equal(receipts.read(ids[2].id, ids[2].nonce, null).state, 'denied');
  time += 101;
  assert.equal(receipts.read(ids[2].id, ids[2].nonce, null), null);
});
