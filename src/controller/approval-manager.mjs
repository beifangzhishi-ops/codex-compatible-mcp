import crypto from 'node:crypto';

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;

function intentFor(args, environmentId) {
  return {
    environment_id: String(environmentId),
    cmd: String(args.cmd),
    workdir: args.workdir == null ? null : String(args.workdir),
    tty: Boolean(args.tty),
    shell: args.shell == null ? null : String(args.shell),
  };
}

function hashIntent(intent) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(intent))
    .digest('hex');
}

export class ApprovalManager {
  constructor({
    ttlMs = DEFAULT_APPROVAL_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.requests = new Map();
  }

  #prune() {
    const now = this.now();
    for (const [id, request] of this.requests) {
      if (request.expiresAt <= now) this.requests.delete(id);
    }
  }

  requestExecution(args, environmentId) {
    this.#prune();
    const intent = intentFor(args, environmentId);
    const approvalId = crypto.randomUUID();
    const createdAt = this.now();
    const request = {
      approvalId,
      state: 'pending',
      intent,
      intentHash: hashIntent(intent),
      justification: String(
        args.justification ||
        'Allow this command to run once with full-access outside the CCM sandbox?',
      ),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.requests.set(approvalId, request);
    return this.#publicRequest(request);
  }

  respond(approvalId, decision) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'pending') {
      throw new Error('Approval request is already ' + request.state + '.');
    }
    if (!['approve', 'deny'].includes(decision)) {
      throw new Error('Approval decision must be approve or deny.');
    }
    request.state = decision === 'approve' ? 'approved' : 'denied';
    request.respondedAt = this.now();
    return this.#publicRequest(request);
  }

  consumeExecution(approvalId, args, environmentId) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'approved') {
      throw new Error('Approval request is not approved; state=' + request.state + '.');
    }

    const intent = intentFor(args, environmentId);
    if (hashIntent(intent) !== request.intentHash) {
      throw new Error(
        'Approved escalation does not match this execution request. ' +
        'Request a new approval for the changed command or execution context.',
      );
    }

    request.state = 'consumed';
    request.consumedAt = this.now();
    return this.#publicRequest(request);
  }

  #publicRequest(request) {
    return {
      approval_id: request.approvalId,
      state: request.state,
      environment_id: request.intent.environment_id,
      command: request.intent.cmd,
      workdir: request.intent.workdir,
      tty: request.intent.tty,
      shell: request.intent.shell,
      justification: request.justification,
      expires_at: new Date(request.expiresAt).toISOString(),
      intent_sha256: request.intentHash,
    };
  }
}

export { DEFAULT_APPROVAL_TTL_MS };
