import crypto from 'node:crypto';

const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60 * 1000;

function normalizePositiveDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function intentFor(args, environmentId) {
  return {
    type: 'execution',
    environment_id: String(environmentId),
    cmd: String(args.cmd),
    workdir: args.workdir == null ? null : String(args.workdir),
    tty: Boolean(args.tty),
    shell: args.shell == null ? null : String(args.shell),
    prefix_rule: Array.isArray(args.prefix_rule)
      ? args.prefix_rule.map((token) => String(token))
      : null,
    policy_kind: args.policy_kind == null ? null : String(args.policy_kind),
    policy_persistable: Boolean(args.policy_persistable),
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
    prefix_rule: Array.isArray(args.prefix_rule)
      ? Object.freeze(args.prefix_rule.map((token) => String(token)))
      : null,
    policy_kind: args.policy_kind == null ? null : String(args.policy_kind),
    policy_persistable: Boolean(args.policy_persistable),
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
    terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
    now = () => Date.now(),
    audit = null,
  } = {}) {
    this.ttlMs = normalizePositiveDuration(ttlMs, DEFAULT_APPROVAL_TTL_MS);
    this.terminalRetentionMs = normalizePositiveDuration(
      terminalRetentionMs,
      DEFAULT_TERMINAL_RETENTION_MS,
    );
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
        'approved_retryable',
      ]);
      const terminalAt = request.consumedAt ??
        request.unknownAt ??
        request.respondedAt ??
        request.expiresAt;
      const terminalRetentionExpired =
        !activeExpiryStates.has(request.state) &&
        request.state !== 'dispatching' &&
        terminalAt + this.terminalRetentionMs <= now;
      if ((activeExpiryStates.has(request.state) && request.expiresAt <= now) ||
          terminalRetentionExpired) {
        this.#emit('expired', request);
        this.requests.delete(id);
      }
    }
  }

  requestExecution(args, environmentId, { workspace = {} } = {}) {
    this.#prune();
    const intent = intentFor(args, environmentId);
    const approvalId = crypto.randomUUID();
    const createdAt = this.now();
    const request = {
      approvalId,
      operationId: crypto.randomUUID(),
      state: 'pending',
      kind: 'execution',
      intent,
      intentHash: hashIntent(intent),
      action: frozenExecutionAction(args, environmentId, workspace),
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

  requestWorkspaceAction(
    operation,
    args,
    justification,
  ) {
    this.#prune();
    const intent = workspaceIntentFor(operation, args);
    const approvalId = crypto.randomUUID();
    const createdAt = this.now();
    const request = {
      approvalId,
      operationId: crypto.randomUUID(),
      state: 'pending',
      kind: 'workspace',
      intent,
      intentHash: hashIntent(intent),
      action: Object.freeze({ ...intent }),
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

  getRequest(approvalId) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    return this.#publicRequest(request);
  }

  prepareAppApproval(approvalId, { hostSession = null } = {}) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.state !== 'pending') {
      throw new Error(
        'Approval request cannot be presented from state=' + request.state + '.',
      );
    }
    if (request.approvalNonceHash) {
      throw new Error('Approval request is already bound to an approval card.');
    }
    const approvalNonce = crypto.randomBytes(32).toString('base64url');
    request.approvalNonceHash = hashSecret(approvalNonce);
    request.hostSession = hostSession ? String(hostSession) : null;
    request.appBoundAt = this.now();
    this.#emit('app_bound', request);
    return {
      request: this.#publicRequest(request),
      approvalNonce,
    };
  }

  claimAppExecution(approvalId, approvalNonce, hostSession = null) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'execution' || !request.approvalNonceHash) {
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
    if (request.hostSession &&
        request.hostSession !== String(hostSession || '')) {
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
    if (request.kind !== 'execution' || !request.approvalNonceHash) {
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
    if (request.hostSession &&
        request.hostSession !== String(hostSession || '')) {
      throw new Error('Approval request belongs to a different host session.');
    }
    request.state = 'denied';
    request.respondedAt = this.now();
    this.#emit('responded', request, { decision: 'deny' });
    return this.#publicRequest(request);
  }

  claimAppWorkspace(approvalId, approvalNonce, hostSession = null) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'workspace' || !request.approvalNonceHash) {
      throw new Error('Approval request is not an app workspace approval.');
    }
    if (request.state !== 'pending') {
      throw new Error(
        'Workspace approval request cannot dispatch from state=' +
        request.state + '.',
      );
    }
    if (!secretMatches(approvalNonce, request.approvalNonceHash)) {
      throw new Error('Approval nonce is invalid.');
    }
    if (request.hostSession &&
        request.hostSession !== String(hostSession || '')) {
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

  denyAppWorkspace(approvalId, approvalNonce, hostSession = null) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'workspace' || !request.approvalNonceHash) {
      throw new Error('Approval request is not an app workspace approval.');
    }
    if (request.state !== 'pending') {
      throw new Error(
        'Workspace approval request cannot be denied from state=' +
        request.state + '.',
      );
    }
    if (!secretMatches(approvalNonce, request.approvalNonceHash)) {
      throw new Error('Approval nonce is invalid.');
    }
    if (request.hostSession &&
        request.hostSession !== String(hostSession || '')) {
      throw new Error('Approval request belongs to a different host session.');
    }
    request.state = 'denied';
    request.respondedAt = this.now();
    this.#emit('responded', request, { decision: 'deny' });
    return this.#publicRequest(request);
  }

  markAppWorkspaceConsumed(approvalId) {
    this.#prune();
    const request = this.requests.get(String(approvalId));
    if (!request) throw new Error('Unknown or expired approval_id.');
    if (request.kind !== 'workspace' || !request.approvalNonceHash) {
      throw new Error('Approval request is not an app workspace approval.');
    }
    if (request.state !== 'dispatching') {
      throw new Error(
        'Workspace approval request is not dispatching; state=' +
        request.state + '.',
      );
    }
    request.state = 'consumed';
    request.consumedAt = this.now();
    this.#emit('consumed', request);
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
    if (request.kind !== 'execution' || !request.approvalNonceHash) {
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

  #publicRequest(request) {
    const result = {
      approval_id: request.approvalId,
      operation_id: request.operationId,
      state: request.state,
      kind: request.kind,
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
      prefix_rule: request.intent.prefix_rule,
      policy_kind: request.intent.policy_kind,
      policy_persistable: request.intent.policy_persistable,
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

export {
  DEFAULT_APPROVAL_TTL_MS,
  DEFAULT_TERMINAL_RETENTION_MS,
};
