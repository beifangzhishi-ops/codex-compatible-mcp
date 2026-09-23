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
    yield_time_ms: args.yield_time_ms == null
      ? null
      : Number(args.yield_time_ms),
    max_output_tokens: args.max_output_tokens == null
      ? null
      : Number(args.max_output_tokens),
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
    create_if_missing: Boolean(args.create_if_missing),
  };
}

function hashIntent(intent) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(intent))
    .digest('hex');
}

function hashSecret(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest();
}

function secretMatches(value, expectedHash) {
  if (!expectedHash) return false;
  const actual = hashSecret(value);
  return actual.length === expectedHash.length &&
    crypto.timingSafeEqual(actual, expectedHash);
}

function frozenExecutionAction(args, environmentId, workspace = {}) {
  return Object.freeze({
    workspace_context: String(args.workspace_context),
    environment_id: String(environmentId),
    workspace_id: workspace.workspace_id == null
      ? null
      : String(workspace.workspace_id),
    workspace_kind: workspace.workspace_kind == null
      ? null
      : String(workspace.workspace_kind),
    workspace_root: workspace.workspace_root == null
      ? null
      : String(workspace.workspace_root),
    cmd: String(args.cmd),
    workdir: args.workdir == null ? null : String(args.workdir),
    tty: Boolean(args.tty),
    shell: args.shell == null ? null : String(args.shell),
    yield_time_ms: args.yield_time_ms == null
      ? null
      : Number(args.yield_time_ms),
    max_output_tokens: args.max_output_tokens == null
      ? null
      : Number(args.max_output_tokens),
  });
}

export class ApprovalManager {
  constructor({
    ttlMs = DEFAULT_APPROVAL_TTL_MS,
    now = () => Date.now(),
    audit = null,
  } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.audit = typeof audit === 'function' ? audit : null;
    this.requests = new Map();
  }

  #emit(event, request, extra = {}) {
    if (!this.audit || !request) return;
    this.audit({
      component: 'approval',
      event,
      approval_id: request.approvalId,
      operation_id: request.operationId,
      kind: request.kind,
      channel: request.channel,
      state: request.state,
      environment_id: request.intent?.environment_id,
      workspace_context: request.intent?.workspace_context || undefined,
      workspace_id:
        request.action?.workspace_id || request.intent?.workspace_id || undefined,
      intent_sha256: request.intentHash,
      ...extra,
    });
  }

  #prune() {
    const now = this.now();
    for (const [id, request] of this.requests) {
      const activeExpiryStates = new Set([
        'pending',
        'approved',
        'approved_retryable',
      ]);
      const terminalRetentionExpired =
        !activeExpiryStates.has(request.state) &&
        request.state !== 'dispatching' &&
        request.expiresAt + this.ttlMs <= now;
      if ((activeExpiryStates.has(request.state) && request.expiresAt <= now) ||
          terminalRetentionExpired) {
        this.#emit('expired', request);
        this.requests.delete(id);
      }
    }
  }

  requestExecution(args, environmentId) {
    this.#prune();
    const intent = intentFor(args, environmentId);
    const approvalId = crypto.randomUUID();
    const createdAt = this.now();
    const request = {
      approvalId,
      operationId: crypto.randomUUID(),
      state: 'pending',
      kind: 'execution',
      channel: 'legacy',
      intent,
      intentHash: hashIntent(intent),
      action: frozenExecutionAction(args, environmentId),
      justification: String(
        args.justification ||
        'Allow this command to run once with full-access outside the CCM sandbox?',
      ),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.requests.set(approvalId, request);
    this.#emit('requested', request);
    return this.#publicRequest(request);
  }

  requestExecutionForApp(
    args,
    environmentId,
    { workspace = {}, hostSession = null } = {},
  ) {
    this.#prune();
    const intent = intentFor(args, environmentId);
    const approvalId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const approvalNonce = crypto.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const request = {
      approvalId,
      operationId,
      state: 'pending',
      kind: 'execution',
      channel: 'app',
      intent,
      intentHash: hashIntent(intent),
      action: frozenExecutionAction(args, environmentId, workspace),
      approvalNonceHash: hashSecret(approvalNonce),
      hostSession: hostSession ? String(hostSession) : null,
      justification: String(
        args.justification ||
        'Allow this command to run once with full-access outside the CCM sandbox?',
      ),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    };
    this.requests.set(approvalId, request);
    this.#emit('requested', request);
    return {
      request: this.#publicRequest(request),
      approvalNonce,
    };
  }

  requestWorkspaceAction(operation, args, justification) {
    this.#prune();
    const intent = workspaceIntentFor(operation, args);
    const approvalId = crypto.randomUUID();
    const createdAt = this.now();
    const request = {
      approvalId,
      operationId: crypto.randomUUID(),
      state: 'pending',
      kind: 'workspace',
      channel: 'legacy',
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
    this.#emit('requested', request);
    return this.#publicRequest(request);
  }

  respond(approvalId, decision) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.channel === 'app') {
      throw new Error(
        'This approval is controlled by the CCM approval card and cannot be resolved through respond_to_escalation.',
      );
    }
    if (request.state !== 'pending') {
      throw new Error('Approval request is already ' + request.state + '.');
    }
    if (!['approve', 'deny'].includes(decision)) {
      throw new Error('Approval decision must be approve or deny.');
    }
    request.state = decision === 'approve' ? 'approved' : 'denied';
    request.respondedAt = this.now();
    this.#emit('responded', request, { decision });
    return this.#publicRequest(request);
  }

  validateExecution(approvalId, args, environmentId) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'execution') {
      throw new Error('Approval request is not for command execution.');
    }
    if (request.channel !== 'legacy') {
      throw new Error('Approval request is not a legacy execution approval.');
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

    return this.#publicRequest(request);
  }

  claimLegacyExecution(approvalId, args, environmentId) {
    this.validateExecution(approvalId, args, environmentId);
    const request = this.requests.get(String(approvalId));
    request.state = 'dispatching';
    request.dispatchStartedAt = this.now();
    this.#emit('dispatching', request);
    return this.#publicRequest(request);
  }

  restoreLegacyExecution(approvalId) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'execution' || request.channel !== 'legacy') {
      throw new Error('Approval request is not a legacy execution approval.');
    }
    if (request.state !== 'dispatching') {
      throw new Error(
        'Approval request is not dispatching; state=' + request.state + '.',
      );
    }
    request.state = 'approved';
    delete request.dispatchStartedAt;
    this.#emit('dispatch_reverted', request);
    return this.#publicRequest(request);
  }

  consumeExecution(approvalId, args, environmentId) {
    this.#prune();
    let request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'dispatching') {
      this.validateExecution(approvalId, args, environmentId);
      request = this.requests.get(String(approvalId));
    } else {
      if (request.kind !== 'execution' || request.channel !== 'legacy') {
        throw new Error('Approval request is not a legacy execution approval.');
      }
      const intent = intentFor(args, environmentId);
      if (hashIntent(intent) !== request.intentHash) {
        throw new Error(
          'Approved escalation does not match this execution request. ' +
          'Request a new approval for the changed command or execution context.',
        );
      }
    }

    request.state = 'consumed';
    request.consumedAt = this.now();
    this.#emit('consumed', request);
    return this.#publicRequest(request);
  }

  markLegacyExecutionUnknown(approvalId) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'execution' || request.channel !== 'legacy') {
      throw new Error('Approval request is not a legacy execution approval.');
    }
    if (!['approved', 'dispatching'].includes(request.state)) {
      throw new Error(
        'Approval request is not active; state=' + request.state + '.',
      );
    }
    request.state = 'execution_unknown';
    request.unknownAt = this.now();
    this.#emit('execution_unknown', request);
    return this.#publicRequest(request);
  }

  claimAppExecution(approvalId, approvalNonce, hostSession = null) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'execution' || request.channel !== 'app') {
      throw new Error('Approval request is not an app execution approval.');
    }
    if (!['pending', 'approved_retryable'].includes(request.state)) {
      throw new Error(
        'Approval request cannot dispatch from state=' + request.state + '.',
      );
    }
    if (!secretMatches(approvalNonce, request.approvalNonceHash)) {
      throw new Error('Approval nonce is invalid.');
    }
    if (request.hostSession && hostSession &&
        request.hostSession !== String(hostSession)) {
      throw new Error('Approval request belongs to a different host session.');
    }
    request.state = 'dispatching';
    request.approvedAt ??= this.now();
    request.dispatchStartedAt = this.now();
    this.#emit('dispatching', request);
    return {
      request: this.#publicRequest(request),
      action: { ...request.action },
    };
  }

  denyAppExecution(approvalId, approvalNonce, hostSession = null) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'execution' || request.channel !== 'app') {
      throw new Error('Approval request is not an app execution approval.');
    }
    if (!['pending', 'approved_retryable'].includes(request.state)) {
      throw new Error(
        'Approval request cannot be denied from state=' + request.state + '.',
      );
    }
    if (!secretMatches(approvalNonce, request.approvalNonceHash)) {
      throw new Error('Approval nonce is invalid.');
    }
    if (request.hostSession && hostSession &&
        request.hostSession !== String(hostSession)) {
      throw new Error('Approval request belongs to a different host session.');
    }
    request.state = 'denied';
    request.respondedAt = this.now();
    this.#emit('responded', request, { decision: 'deny' });
    return this.#publicRequest(request);
  }

  markAppExecutionConsumed(approvalId) {
    return this.#transitionDispatchState(approvalId, 'consumed');
  }

  markAppExecutionRetryable(approvalId) {
    return this.#transitionDispatchState(approvalId, 'approved_retryable');
  }

  markAppExecutionUnknown(approvalId) {
    return this.#transitionDispatchState(approvalId, 'execution_unknown');
  }

  #transitionDispatchState(approvalId, nextState) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'execution' || request.channel !== 'app') {
      throw new Error('Approval request is not an app execution approval.');
    }
    if (request.state !== 'dispatching') {
      throw new Error(
        'Approval request is not dispatching; state=' + request.state + '.',
      );
    }
    request.state = nextState;
    if (nextState === 'consumed') request.consumedAt = this.now();
    if (nextState === 'approved_retryable') request.retryableAt = this.now();
    if (nextState === 'execution_unknown') request.unknownAt = this.now();
    this.#emit(nextState, request);
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
    this.#emit('consumed', request);
    return this.#publicRequest(request);
  }

  #publicRequest(request) {
    const result = {
      approval_id: request.approvalId,
      operation_id: request.operationId,
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
        create_if_missing: request.intent.create_if_missing,
      };
    }
    return {
      ...result,
      command: request.intent.cmd,
      workdir: request.intent.workdir,
      tty: request.intent.tty,
      shell: request.intent.shell,
      workspace_context: request.intent.workspace_context,
      ...(request.action?.workspace_id
        ? { workspace_id: request.action.workspace_id }
        : {}),
      ...(request.action?.workspace_kind
        ? { workspace_kind: request.action.workspace_kind }
        : {}),
      ...(request.action?.workspace_root
        ? { workspace_root: request.action.workspace_root }
        : {}),
    };
  }
}

export { DEFAULT_APPROVAL_TTL_MS };
