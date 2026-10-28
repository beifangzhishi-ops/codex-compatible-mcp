import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECEIPTS = 4096;

function nonceHash(nonce) {
  return crypto.createHash('sha256').update(String(nonce)).digest('hex');
}

function sameHash(nonce, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return crypto.timingSafeEqual(Buffer.from(nonceHash(nonce), 'hex'), Buffer.from(expected, 'hex'));
}

// A receipt can restore a finished card, but can never authorize an action.
export class ApprovalReceiptStore {
  constructor({ stateFile, now = Date.now, retentionMs = DEFAULT_RETENTION_MS,
    maxReceipts = DEFAULT_MAX_RECEIPTS } = {}) {
    this.stateFile = stateFile || null;
    this.now = now;
    this.retentionMs = retentionMs;
    this.maxReceipts = maxReceipts;
    this.receipts = new Map();
    if (this.stateFile && fs.existsSync(this.stateFile)) {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8').replace(/^\uFEFF/, ''));
      let migrated = false;
      for (const receipt of data?.receipts || []) {
        if (receipt && typeof receipt.approval_id === 'string' &&
            Number.isFinite(receipt.saved_at) && receipt.saved_at + this.retentionMs > this.now()) {
          const value = { ...receipt };
          if (typeof value.workspace_context === 'string') {
            value.workspace_handle = value.workspace_context;
            delete value.workspace_context;
            migrated = true;
          }
          this.receipts.set(value.approval_id, value);
        }
      }
      this.#prune();
      if (migrated) this.#persist();
    }
  }

  #prune() {
    const now = this.now();
    for (const [id, value] of this.receipts) {
      if (value.saved_at + this.retentionMs <= now) this.receipts.delete(id);
    }
    const excess = this.receipts.size - this.maxReceipts;
    if (excess > 0) {
      const sorted = [...this.receipts].sort((a, b) => a[1].saved_at - b[1].saved_at);
      for (const [id] of sorted.slice(0, excess)) this.receipts.delete(id);
    }
  }

  #persist() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temporary = this.stateFile + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, receipts: [...this.receipts.values()] }) + '\n', { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, this.stateFile);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  save(request, result) {
    if (!['consumed', 'denied', 'execution_unknown'].includes(result?.state)) return;
    if (!request?.approvalNonceHash) return;
    const value = {
      approval_id: request.approvalId,
      operation_id: request.operationId,
      nonce_hash: request.approvalNonceHash.toString('hex'),
      host_session: request.hostSession || null,
      kind: request.kind,
      operation: request.kind === 'workspace' ? request.intent.operation : null,
      environment_id: request.intent.environment_id,
      workspace_id: request.action?.workspace_id || null,
      state: result.state,
      action_failed: result.action_failed === true,
      decision: result.state === 'denied' ? 'deny' : 'approve',
      // Never store execution output, command text, or a projectless context.
      ...(request.kind === 'workspace' &&
          ['select_workspace', 'register_workspace'].includes(request.intent.operation) &&
          result.state === 'consumed' && !result.action_failed &&
          result.workspace_kind === 'registered' &&
          typeof result.workspace_handle === 'string'
        ? { workspace_handle: result.workspace_handle } : {}),
      saved_at: this.now(),
    };
    this.receipts.set(value.approval_id, value);
    this.#prune();
    this.#persist();
  }

  read(approvalId, nonce, hostSession) {
    this.#prune();
    const receipt = this.receipts.get(String(approvalId));
    if (!receipt) return null;
    if (!sameHash(nonce, receipt.nonce_hash) ||
        (receipt.host_session && receipt.host_session !== String(hostSession || ''))) {
      throw new Error('Approval card capability is invalid.');
    }
    const { nonce_hash, host_session, saved_at, ...publicReceipt } = receipt;
    return { ...publicReceipt, approval_required: false };
  }
}

export { DEFAULT_RETENTION_MS, DEFAULT_MAX_RECEIPTS };
