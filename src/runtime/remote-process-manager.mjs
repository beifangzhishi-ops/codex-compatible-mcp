import { randomUUID } from 'node:crypto';
import { isTrustedRemoteGitCommand } from './sandbox/git-policy.mjs';
import {
  hashPackageScript,
  parsePackageScriptCommand,
} from '../controller/exec-policy-store.mjs';

const DEFAULT_EXEC_YIELD_TIME_MS = 2_000;
const MAX_INITIAL_EXEC_YIELD_TIME_MS = 5_000;

function clampInitialExecYield(milliseconds) {
  const value = Number(milliseconds ?? DEFAULT_EXEC_YIELD_TIME_MS);
  if (!Number.isFinite(value)) return DEFAULT_EXEC_YIELD_TIME_MS;
  return Math.max(0, Math.min(MAX_INITIAL_EXEC_YIELD_TIME_MS, value));
}

export class RemoteProcessManager {
  constructor({
    environmentRegistry,
    workerHub,
    approvalManager = null,
    workspaceContextManager = null,
    execPolicyStore = null,
    trustedPackageScriptStore = null,
    audit = null,
  }) {
    if (!environmentRegistry || !workerHub) {
      throw new Error('RemoteProcessManager requires environmentRegistry and workerHub.');
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.approvalManager = approvalManager;
    this.workspaceContextManager = workspaceContextManager;
    this.execPolicyStore = execPolicyStore;
    this.trustedPackageScriptStore = trustedPackageScriptStore;
    this.audit = typeof audit === 'function' ? audit : null;
    this.sessions = new Map();
    this.nextSessionId = 1000;
    this.onEnvironmentDisconnected = (environmentId) => {
      for (const [sessionId, session] of this.sessions) {
        if (session.environmentId === environmentId) {
          this.sessions.delete(sessionId);
        }
      }
    };
    this.workerHub.on(
      'environment_disconnected',
      this.onEnvironmentDisconnected,
    );
  }

  #allocateSessionId() {
    do {
      this.nextSessionId += 1;
      if (this.nextSessionId > 2_000_000_000) this.nextSessionId = 1000;
    } while (this.sessions.has(this.nextSessionId));
    return this.nextSessionId;
  }

  #emit(event, fields = {}) {
    if (!this.audit) return;
    this.audit({ component: 'process', event, ...fields });
  }

  #recordExecResult(result, environment, workspaceContext, operationId = null) {
    if (result?.session_id !== undefined) {
      const publicSessionId = this.#allocateSessionId();
      this.sessions.set(publicSessionId, {
        environmentId: environment.id,
        remoteSessionId: result.session_id,
        workspaceContext: workspaceContext.workspace_context,
        workspace: { ...workspaceContext },
        operationId,
      });
      this.#emit('session_created', {
        operation_id: operationId || undefined,
        public_session_id: publicSessionId,
        remote_session_id: result.session_id,
        environment_id: environment.id,
        workspace_context: workspaceContext.workspace_context,
        workspace_id: workspaceContext.workspace_id,
      });
      return {
        ...result,
        session_id: publicSessionId,
        ...(operationId ? { operation_id: operationId } : {}),
        ...workspaceContext,
      };
    }
    this.#emit('exec_completed', {
      operation_id: operationId || undefined,
      environment_id: environment.id,
      workspace_context: workspaceContext.workspace_context,
      workspace_id: workspaceContext.workspace_id,
      exit_code: result?.exit_code,
    });
    return {
      ...result,
      ...(operationId ? { operation_id: operationId } : {}),
      ...workspaceContext,
    };
  }

  #approvalStatusResult(approval, workspaceContext, output) {
    return {
      chunk_id: 'approval',
      wall_time_seconds: 0,
      output,
      approval_required: approval.state === 'pending',
      ...approval,
      ...(workspaceContext || {}),
    };
  }

  async #resolvePackageScriptBinding(args, workspaceContext, environment) {
    const parsed = parsePackageScriptCommand(args.cmd);
    if (!parsed) return null;
    if (environment.platform !== 'windows') {
      throw new Error(
        'Persistent package-script approval currently requires a Windows worker.',
      );
    }
    const scriptName = parsed.script.replace(/'/g, "''");
    const probe = [
      "$p=Get-Content -Raw -LiteralPath package.json | ConvertFrom-Json",
      "$value=$p.scripts | Select-Object -ExpandProperty '" + scriptName +
        "' -ErrorAction SilentlyContinue",
      "if($null -eq $value){exit 42}",
      "[string]$value | ConvertTo-Json -Compress",
    ].join('; ');
    const result = await this.workerHub.call(
      environment.id,
      'exec_command',
      {
        cmd: probe,
        environment_id: environment.id,
        workspace_id: workspaceContext.workspace_id,
        expected_workspace_root: workspaceContext.workspace_root,
        sandbox_permissions: 'use_default',
        shell: 'powershell.exe',
        yield_time_ms: 2_000,
        ...(args.workdir ? { workdir: args.workdir } : {}),
      },
      { timeoutMs: 12_000 },
    );
    if (result?.exit_code !== 0) {
      throw new Error(
        'Could not resolve package.json script "' + parsed.script + '" for persistent approval.',
      );
    }
    const serialized = String(result?.output || '').trim();
    if (!serialized) {
      throw new Error(
        'Package script "' + parsed.script + '" resolved to an empty policy probe.',
      );
    }
    let scriptText;
    try {
      scriptText = JSON.parse(serialized);
    } catch {
      throw new Error('Package script policy probe returned invalid data.');
    }
    if (typeof scriptText !== 'string' || scriptText.length === 0) {
      throw new Error('Package script policy probe returned invalid data.');
    }
    return {
      ...parsed,
      script_sha256: hashPackageScript(scriptText),
    };
  }

  async #matchExecPolicy(args, workspaceContext, environment) {
    if (!this.execPolicyStore) return null;
    let packageScript = null;
    if (parsePackageScriptCommand(args.cmd)) {
      try {
        packageScript = await this.#resolvePackageScriptBinding(
          args,
          workspaceContext,
          environment,
        );
      } catch (error) {
        this.#emit('exec_policy_probe_failed', {
          environment_id: environment.id,
          workspace_context: workspaceContext.workspace_context,
          workspace_id: workspaceContext.workspace_id,
          error_name: error?.name || 'Error',
        });
        return null;
      }
    }
    return this.execPolicyStore.match({
      workspaceContext,
      environment,
      args,
      packageScript,
    });
  }

  async #prepareExecPolicyBinding(args, workspaceContext, environment) {
    if (!this.execPolicyStore) {
      throw new Error('CCM exec policy store is not available.');
    }
    return parsePackageScriptCommand(args.cmd)
      ? await this.#resolvePackageScriptBinding(args, workspaceContext, environment)
      : null;
  }

  async #matchTrustedPackageScript(args, workspaceContext, environment) {
    if (!this.trustedPackageScriptStore ||
        environment.permissionProfile !== 'workspace-write' ||
        !this.trustedPackageScriptStore.mayMatch({
          workspaceContext,
          environment,
          args,
        })) {
      return null;
    }
    try {
      const packageScript = await this.#resolvePackageScriptBinding(
        args,
        workspaceContext,
        environment,
      );
      return this.trustedPackageScriptStore.match({
        workspaceContext,
        environment,
        args,
        packageScript,
      });
    } catch (error) {
      this.#emit('trusted_package_script_probe_failed', {
        environment_id: environment.id,
        workspace_context: workspaceContext.workspace_context,
        workspace_id: workspaceContext.workspace_id,
        error_name: error?.name || 'Error',
      });
      return null;
    }
  }

  isSessionLive(sessionId, workspaceContext = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return !workspaceContext || session.workspaceContext === workspaceContext;
  }

  sessionMetadata(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      session_id: sessionId,
      operation_id: session.operationId || null,
      environment_id: session.environmentId,
      workspace_context: session.workspaceContext,
      ...(session.workspace || {}),
    };
  }

  async execCommand(args, { policyRuleOverride = null } = {}) {
    if (!args.workspace_context) {
      throw new Error(
        'exec_command requires workspace_context. Obtain one explicitly before execution.',
      );
    }
    if (args.environment_id) {
      throw new Error(
        'exec_command does not accept environment_id; workspace_context already determines the environment.',
      );
    }
    if (!this.workspaceContextManager) {
      throw new Error('Workspace context manager is not available.');
    }
    const workspaceContext = this.workspaceContextManager.resolve(
      args.workspace_context,
    );
    const environment = this.environmentRegistry.resolve(
      workspaceContext.environment_id,
    );
    let operationId = randomUUID();
    let forwardedArgs = {
      ...args,
      environment_id: environment.id,
      workspace_id: workspaceContext.workspace_id,
      expected_workspace_root: workspaceContext.workspace_root,
    };
    delete forwardedArgs.workspace_context;
    const requestedYieldMs = clampInitialExecYield(args.yield_time_ms);
    forwardedArgs = {
      ...forwardedArgs,
      yield_time_ms: requestedYieldMs,
    };
    const requestedEscalation = args.sandbox_permissions === 'require_escalated';
    const trustedGit = environment.permissionProfile === 'workspace-write' &&
      isTrustedRemoteGitCommand(args.cmd);
    const trustedPackageScriptRule = await this.#matchTrustedPackageScript(
      args,
      workspaceContext,
      environment,
    );
    const trustedPackageScript = Boolean(trustedPackageScriptRule);
    const wantsEscalation =
      requestedEscalation && !trustedGit && !trustedPackageScript;
    let policyRule = policyRuleOverride;
    let legacyApprovalId = null;
    let legacyApprovalArgs = null;

    if (requestedEscalation && trustedGit) {
      forwardedArgs = {
        ...forwardedArgs,
        sandbox_permissions: 'use_default',
      };
      delete forwardedArgs.approval_id;
      delete forwardedArgs.justification;
    }

    if (trustedPackageScript) {
      forwardedArgs = {
        ...forwardedArgs,
        sandbox_permissions: 'approved_escalated',
      };
      delete forwardedArgs.approval_id;
      delete forwardedArgs.justification;
      this.#emit('trusted_package_script_auto_allowed', {
        rule_id: trustedPackageScriptRule.rule_id,
        operation_id: operationId,
        environment_id: environment.id,
        workspace_context: workspaceContext.workspace_context,
        workspace_id: workspaceContext.workspace_id,
      });
    }

    if (args.approval_id && !requestedEscalation) {
      throw new Error(
        'approval_id is only valid with sandbox_permissions=require_escalated.',
      );
    }

    if (wantsEscalation && environment.permissionProfile !== 'full-access') {
      if (!this.approvalManager) {
        throw new Error('Escalated execution requires an approval manager.');
      }
      if (!args.approval_id && !policyRule) {
        policyRule = await this.#matchExecPolicy(
          args,
          workspaceContext,
          environment,
        );
      }
      if (policyRule?.decision === 'allow') {
        forwardedArgs = {
          ...forwardedArgs,
          sandbox_permissions: 'approved_escalated',
        };
        delete forwardedArgs.approval_id;
        delete forwardedArgs.justification;
        this.#emit('exec_policy_auto_allowed', {
          rule_id: policyRule.rule_id,
          operation_id: operationId,
          environment_id: environment.id,
          workspace_context: workspaceContext.workspace_context,
          workspace_id: workspaceContext.workspace_id,
        });
      } else if (!args.approval_id) {
        const approval = this.approvalManager.requestExecution(
          {
            ...args,
            workspace_context: workspaceContext.workspace_context,
          },
          environment.id,
        );
        return {
          chunk_id: 'approval',
          wall_time_seconds: 0,
          output:
            'Approval required before this command can run outside the sandbox.',
          approval_required: true,
          ...approval,
          ...(workspaceContext || {}),
        };
      } else {
        legacyApprovalArgs = {
          ...args,
          workspace_context: workspaceContext.workspace_context,
        };
        const validatedApproval = this.approvalManager.claimLegacyExecution(
          args.approval_id,
          legacyApprovalArgs,
          environment.id,
        );
        operationId = validatedApproval.operation_id;
        legacyApprovalId = args.approval_id;
        forwardedArgs = {
          ...forwardedArgs,
          sandbox_permissions: 'approved_escalated',
        };
        delete forwardedArgs.approval_id;
      }
    } else if (wantsEscalation) {
      forwardedArgs = {
        ...forwardedArgs,
        sandbox_permissions: 'use_default',
      };
      delete forwardedArgs.approval_id;
    }

    const timeoutMs = Math.max(
      15_000,
      requestedYieldMs + 10_000,
    );
    let dispatch;
    try {
      this.#emit('exec_dispatch', {
        operation_id: operationId,
        environment_id: environment.id,
        workspace_context: workspaceContext.workspace_context,
        workspace_id: workspaceContext.workspace_id,
      });
      dispatch = this.workerHub.call(
        environment.id,
        'exec_command',
        forwardedArgs,
        { timeoutMs },
      );
    } catch (error) {
      // No request left the Controller, so a validated legacy approval remains
      // reusable for the exact same frozen intent.
      if (legacyApprovalId) {
        this.approvalManager.restoreLegacyExecution(legacyApprovalId);
      }
      this.#emit('exec_dispatch_failed_prestart', {
        operation_id: operationId,
        environment_id: environment.id,
        workspace_context: workspaceContext.workspace_context,
        workspace_id: workspaceContext.workspace_id,
        error_name: error?.name || 'Error',
      });
      throw error;
    }
    let result;
    try {
      result = await dispatch;
    } catch (error) {
      if (legacyApprovalId) {
        this.approvalManager.markLegacyExecutionUnknown(legacyApprovalId);
      }
      this.#emit('exec_dispatch_unknown', {
        operation_id: operationId,
        environment_id: environment.id,
        workspace_context: workspaceContext.workspace_context,
        workspace_id: workspaceContext.workspace_id,
        error_name: error?.name || 'Error',
      });
      throw error;
    }
    if (legacyApprovalId) {
      this.approvalManager.consumeExecution(
        legacyApprovalId,
        legacyApprovalArgs,
        environment.id,
      );
    }
    const recorded = this.#recordExecResult(
      result,
      environment,
      workspaceContext,
      operationId,
    );
    if (trustedPackageScriptRule) {
      return {
        ...recorded,
        trusted_package_script: true,
        trusted_package_script_rule_id: trustedPackageScriptRule.rule_id,
      };
    }
    return policyRule
      ? {
        ...recorded,
        policy_auto_approved: true,
        policy_rule_id: policyRule.rule_id,
      }
      : recorded;
  }

  async prepareEscalatedCommand(args, { hostSession = null } = {}) {
    if (!args.workspace_context) {
      throw new Error(
        'request_escalated_exec requires workspace_context.',
      );
    }
    if (!this.workspaceContextManager || !this.approvalManager) {
      throw new Error('Escalated execution services are not available.');
    }
    const workspaceContext = this.workspaceContextManager.resolve(
      args.workspace_context,
    );
    const environment = this.environmentRegistry.resolve(
      workspaceContext.environment_id,
    );
    if (environment.permissionProfile === 'full-access') {
      throw new Error(
        'This environment already runs with full-access; use exec_command directly.',
      );
    }
    if (environment.permissionProfile === 'workspace-write' &&
        isTrustedRemoteGitCommand(args.cmd)) {
      throw new Error(
        'Trusted remote Git does not require escalation; use exec_command directly.',
      );
    }
    const trustedPackageScriptRule = await this.#matchTrustedPackageScript(
      args,
      workspaceContext,
      environment,
    );
    if (trustedPackageScriptRule) {
      const result = await this.execCommand(args);
      return {
        autoApproved: true,
        value: {
          ...result,
          command: String(args.cmd),
          trusted_package_script: true,
          trusted_package_script_rule_id: trustedPackageScriptRule.rule_id,
        },
      };
    }

    const policyRule = await this.#matchExecPolicy(
      args,
      workspaceContext,
      environment,
    );
    if (policyRule?.decision === 'allow') {
      const result = await this.execCommand({
        ...args,
        sandbox_permissions: 'require_escalated',
      }, {
        policyRuleOverride: policyRule,
      });
      return {
        autoApproved: true,
        value: {
          ...result,
          command: String(args.cmd),
          policy_auto_approved: true,
          policy_rule_id: policyRule.rule_id,
        },
      };
    }

    const prepared = this.approvalManager.requestExecutionForApp(
      {
        ...args,
        workspace_context: workspaceContext.workspace_context,
      },
      environment.id,
      { workspace: workspaceContext, hostSession },
    );
    this.#emit('approval_prepared', {
      approval_id: prepared.request.approval_id,
      operation_id: prepared.request.operation_id,
      environment_id: environment.id,
      workspace_context: workspaceContext.workspace_context,
      workspace_id: workspaceContext.workspace_id,
    });
    return {
      value: this.#approvalStatusResult(
        prepared.request,
        workspaceContext,
        'Waiting for the user to approve or deny this frozen full-access command.',
      ),
      approvalNonce: prepared.approvalNonce,
    };
  }

  async resolvePendingExecution(
    { approval_id: approvalId, approval_nonce: approvalNonce, decision },
    { hostSession = null } = {},
  ) {
    if (!this.approvalManager || !this.workspaceContextManager) {
      throw new Error('Escalated execution services are not available.');
    }
    if (decision === 'deny') {
      const denied = this.approvalManager.denyAppExecution(
        approvalId,
        approvalNonce,
        hostSession,
      );
      const workspaceContext = this.workspaceContextManager.resolve(
        denied.workspace_context,
      );
      return this.#approvalStatusResult(
        denied,
        workspaceContext,
        'The user denied this escalated command. It was not dispatched.',
      );
    }
    if (!['approve', 'approve_workspace'].includes(decision)) {
      throw new Error(
        'Approval decision must be approve, approve_workspace, or deny.',
      );
    }

    const claimed = this.approvalManager.claimAppExecution(
      approvalId,
      approvalNonce,
      hostSession,
    );
    const action = claimed.action;
    let workspaceContext;
    let environment;
    let persistentPolicy = null;
    let persistentPolicyPackageScript = null;
    try {
      workspaceContext = this.workspaceContextManager.resolve(
        action.workspace_context,
      );
      environment = this.environmentRegistry.resolve(
        action.environment_id,
      );
      if (workspaceContext.environment_id !== action.environment_id ||
          workspaceContext.workspace_id !== action.workspace_id ||
          workspaceContext.workspace_root !== action.workspace_root) {
        throw new Error(
          'Frozen workspace identity no longer matches the current workspace context.',
        );
      }
      if (decision === 'approve_workspace') {
        persistentPolicyPackageScript = await this.#prepareExecPolicyBinding(
          action,
          workspaceContext,
          environment,
        );
      }
    } catch (error) {
      const retryable = this.approvalManager.markAppExecutionRetryable(
        approvalId,
      );
      this.#emit('approval_dispatch_failed_prestart', {
        approval_id: approvalId,
        operation_id: claimed.request.operation_id,
        environment_id: action.environment_id,
        workspace_context: action.workspace_context,
        workspace_id: action.workspace_id,
        error_name: error?.name || 'Error',
      });
      return this.#approvalStatusResult(
        retryable,
        workspaceContext || {
          workspace_context: action.workspace_context,
          environment_id: action.environment_id,
          workspace_id: action.workspace_id,
          workspace_kind: action.workspace_kind,
          workspace_root: action.workspace_root,
        },
        'Escalated execution was not dispatched: ' +
          String(error?.message || error),
      );
    }

    const requestedYieldMs = clampInitialExecYield(action.yield_time_ms);
    const forwardedArgs = {
      cmd: action.cmd,
      environment_id: environment.id,
      workspace_id: action.workspace_id,
      expected_workspace_root: action.workspace_root,
      sandbox_permissions: 'approved_escalated',
      yield_time_ms: requestedYieldMs,
      ...(action.workdir ? { workdir: action.workdir } : {}),
      ...(action.tty ? { tty: true } : {}),
      ...(action.shell ? { shell: action.shell } : {}),
      ...(action.max_output_tokens != null
        ? { max_output_tokens: action.max_output_tokens }
        : {}),
    };
    const timeoutMs = Math.max(15_000, requestedYieldMs + 10_000);

    let dispatch;
    try {
      this.#emit('approval_dispatch', {
        approval_id: approvalId,
        operation_id: claimed.request.operation_id,
        environment_id: environment.id,
        workspace_context: workspaceContext.workspace_context,
        workspace_id: workspaceContext.workspace_id,
      });
      dispatch = this.workerHub.call(
        environment.id,
        'exec_command',
        forwardedArgs,
        { timeoutMs },
      );
    } catch (error) {
      const retryable = this.approvalManager.markAppExecutionRetryable(
        approvalId,
      );
      this.#emit('approval_dispatch_failed_prestart', {
        approval_id: approvalId,
        operation_id: claimed.request.operation_id,
        environment_id: environment.id,
        workspace_context: workspaceContext.workspace_context,
        workspace_id: workspaceContext.workspace_id,
        error_name: error?.name || 'Error',
      });
      return this.#approvalStatusResult(
        retryable,
        workspaceContext,
        'Escalated execution was not dispatched: ' +
          String(error?.message || error),
      );
    }

    let result;
    try {
      result = await dispatch;
    } catch (error) {
      const unknown = this.approvalManager.markAppExecutionUnknown(approvalId);
      this.#emit('approval_dispatch_unknown', {
        approval_id: approvalId,
        operation_id: claimed.request.operation_id,
        environment_id: environment.id,
        workspace_context: workspaceContext.workspace_context,
        workspace_id: workspaceContext.workspace_id,
        error_name: error?.name || 'Error',
      });
      return this.#approvalStatusResult(
        unknown,
        workspaceContext,
        'Escalated execution outcome is unknown; CCM will not retry automatically: ' +
          String(error?.message || error),
      );
    }

    const recorded = this.#recordExecResult(
      result,
      environment,
      workspaceContext,
      claimed.request.operation_id,
    );
    if (decision === 'approve_workspace') {
      try {
        persistentPolicy = this.execPolicyStore.allow({
          workspaceContext,
          environment,
          args: action,
          packageScript: persistentPolicyPackageScript,
        });
      } catch (error) {
        this.#emit('exec_policy_save_failed', {
          approval_id: approvalId,
          operation_id: claimed.request.operation_id,
          environment_id: environment.id,
          workspace_context: workspaceContext.workspace_context,
          workspace_id: workspaceContext.workspace_id,
          error_name: error?.name || 'Error',
        });
      }
    }
    const consumed = this.approvalManager.markAppExecutionConsumed(approvalId);
    this.#emit('approval_consumed', {
      approval_id: approvalId,
      operation_id: consumed.operation_id,
      environment_id: environment.id,
      workspace_context: workspaceContext.workspace_context,
      workspace_id: workspaceContext.workspace_id,
      public_session_id: recorded.session_id,
      exit_code: recorded.exit_code,
    });
    return {
      ...recorded,
      approval_id: consumed.approval_id,
      state: consumed.state,
      intent_sha256: consumed.intent_sha256,
      ...(persistentPolicy ? {
        policy_saved: true,
        policy_rule_id: persistentPolicy.rule_id,
      } : {}),
    };
  }

  async writeStdin(args) {
    if (!args.workspace_context) {
      throw new Error(
        'write_stdin requires workspace_context from the exec_command result.',
      );
    }
    const session = this.sessions.get(args.session_id);
    if (!session) {
      throw new Error('Unknown or expired session_id: ' + args.session_id);
    }
    if (session.workspaceContext !== args.workspace_context) {
      throw new Error(
        'workspace_context does not own session_id ' + args.session_id + '.',
      );
    }

    const empty = !(args.chars || '').length;
    const requestedYield = Number(
      args.yield_time_ms ?? (empty ? 1_000 : 250),
    );
    const timeoutMs = Math.max(15_000, requestedYield + 10_000);
    const forwardedArgs = { ...args, session_id: session.remoteSessionId };
    delete forwardedArgs.workspace_context;
    const result = await this.workerHub.call(
      session.environmentId,
      'write_stdin',
      forwardedArgs,
      { timeoutMs },
    );
    if (this.sessions.get(args.session_id) !== session) {
      throw new Error(
        'Session identity changed while write_stdin was in flight: ' +
        args.session_id + '.',
      );
    }
    if (result?.session_id !== undefined) {
      this.#emit('session_continued', {
        operation_id: session.operationId || undefined,
        public_session_id: args.session_id,
        remote_session_id: session.remoteSessionId,
        environment_id: session.environmentId,
        workspace_context: session.workspaceContext,
      });
      return {
        ...result,
        session_id: args.session_id,
        ...(session.operationId ? { operation_id: session.operationId } : {}),
        ...(session.workspace || {}),
      };
    }

    this.sessions.delete(args.session_id);
    this.#emit('session_completed', {
      operation_id: session.operationId || undefined,
      public_session_id: args.session_id,
      remote_session_id: session.remoteSessionId,
      environment_id: session.environmentId,
      workspace_context: session.workspaceContext,
      exit_code: result?.exit_code,
    });
    return {
      ...result,
      ...(session.operationId ? { operation_id: session.operationId } : {}),
      ...(session.workspace || {}),
    };
  }

  async terminateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);

    try {
      await this.workerHub.call(
        session.environmentId,
        'terminate_session',
        { session_id: session.remoteSessionId },
        { timeoutMs: 5_000 },
      );
    } catch {}
    return true;
  }

  async terminateAll() {
    const sessionIds = [...this.sessions.keys()];
    await Promise.allSettled(
      sessionIds.map((sessionId) => this.terminateSession(sessionId)),
    );
  }

  async close() {
    await this.terminateAll();
    this.workerHub.off(
      'environment_disconnected',
      this.onEnvironmentDisconnected,
    );
  }
}
