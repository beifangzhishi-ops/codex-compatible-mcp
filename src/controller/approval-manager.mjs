import crypto from 'node:crypto';

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;

function intentFor(args, environmentId) {
  return {
    type: 'execution',
    environment_id: String(environmentId),
    cmd: String(args.cmd),
    workdir: args.workdir == null ? null : String(args.workdir),
    tty: Boolean(args.tty),
    shell: args.shell == null ? null : String(args.shell),
    workspace_context: args.workspace_context == null
      ? null
      : String(args.workspace_context),
  };
}

function workspaceIntentFor(operation, args = {}) {
  return {
    type: 'workspace',
    operation: String(operation),
    environment_id: String(args.environment_id),
    workspace_id: args.workspace_id == null ? null : String(args.workspace_id),
    workspace_root: args.workspace_root == null
      ? null
      : String(args.workspace_root),
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
      kind: 'execution',
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

  requestWorkspaceAction(operation, args, justification) {
    this.#prune();
    const intent = workspaceIntentFor(operation, args);
    const approvalId = crypto.randomUUID();
    const createdAt = this.now();
    const request = {
      approvalId,
      state: 'pending',
      kind: 'workspace',
      intent,
      intentHash: hashIntent(intent),
      justification: String(
        justification ||
        'Allow CCM to access this registered workspace?',
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
    if (request.kind !== 'execution') {
      throw new Error('Approval request is not for command execution.');
    }
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

  consumeWorkspaceAction(approvalId, operation, args) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'workspace') {
      throw new Error('Approval request is not for a workspace action.');
    }
    if (request.state !== 'approved') {
      throw new Error('Approval request is not approved; state=' + request.state + '.');
    }

    const intent = workspaceIntentFor(operation, args);
    if (hashIntent(intent) !== request.intentHash) {
      throw new Error(
        'Approved workspace action does not match this request. ' +
        'Request a new approval for the changed workspace.',
      );
    }

    request.state = 'consumed';
    request.consumedAt = this.now();
    return this.#publicRequest(request);
  }

  #publicRequest(request) {
    const result = {
      approval_id: request.approvalId,
      state: request.state,
      environment_id: request.intent.environment_id,
      justification: request.justification,
      expires_at: new Date(request.expiresAt).toISOString(),
      intent_sha256: request.intentHash,
    };
    if (request.kind === 'workspace') {
      return {
        ...result,
        operation: request.intent.operation,
        workspace_id: request.intent.workspace_id,
        workspace_root: request.intent.workspace_root,
      };
    }
    return {
      ...result,
      command: request.intent.cmd,
      workdir: request.intent.workdir,
      tty: request.intent.tty,
      shell: request.intent.shell,
      workspace_context: request.intent.workspace_context,
    };
  }
}

export { DEFAULT_APPROVAL_TTL_MS };
