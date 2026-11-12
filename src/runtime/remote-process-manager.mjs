import { randomUUID } from 'node:crypto';
import {
  effectiveShell,
  parseShellCommand,
  tokenPrefixMatches,
  validatePrefixTokens,
} from './sandbox/shell-policy-parser.mjs';
import {
  hashPackageScript,
  parsePackageScriptCommand,
} from '../controller/package-script-policy.mjs';
import { isReviewerTool } from '../controller/guardian-tool-context.mjs';

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
    workspaceHandleManager = null,
    codexPolicy = null,
    trustedPackageScriptStore = null,
    webFullAccess = null,
    guardianReviewer = null,
    audit = null,
  }) {
    if (!environmentRegistry || !workerHub) {
      throw new Error('RemoteProcessManager requires environmentRegistry and workerHub.');
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.approvalManager = approvalManager;
    this.workspaceHandleManager = workspaceHandleManager;
    this.codexPolicy = codexPolicy;
    this.trustedPackageScriptStore = trustedPackageScriptStore;
    this.webFullAccess = webFullAccess;
    this.guardianReviewer = guardianReviewer;
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

  #recordExecResult(result, environment, workspaceHandle, operationId = null, tty = false) {
    if (result?.session_id !== undefined) {
      const publicSessionId = this.#allocateSessionId();
      this.sessions.set(publicSessionId, {
        environmentId: environment.id,
        remoteSessionId: result.session_id,
        workspaceHandle: workspaceHandle.workspace_handle,
        workspace: { ...workspaceHandle },
        operationId,
        tty,
        verificationEchoes: [],
      });
      this.#emit('session_created', {
        operation_id: operationId || undefined,
        public_session_id: publicSessionId,
        remote_session_id: result.session_id,
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
      });
      return {
        ...result,
        session_id: publicSessionId,
        ...(operationId ? { operation_id: operationId } : {}),
        ...workspaceHandle,
      };
    }
    this.#emit('exec_completed', {
      operation_id: operationId || undefined,
      environment_id: environment.id,
      workspace_handle: workspaceHandle.workspace_handle,
      workspace_id: workspaceHandle.workspace_id,
      exit_code: result?.exit_code,
    });
    return {
      ...result,
      ...(operationId ? { operation_id: operationId } : {}),
      ...workspaceHandle,
    };
  }

  #approvalStatusResult(approval, workspaceHandle, output) {
    return {
      chunk_id: 'approval',
      wall_time_seconds: 0,
      output,
      approval_required: approval.state === 'pending',
      ...approval,
      ...(workspaceHandle || {}),
    };
  }

  async #resolvePackageScriptBinding(args, workspaceHandle, environment) {
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
        workspace_id: workspaceHandle.workspace_id,
        expected_workspace_root: workspaceHandle.workspace_root,
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

  #parseCommand(args, environment) {
    return parseShellCommand(args.cmd, {
      shell: effectiveShell(args, environment),
    });
  }

  #persistentPolicyProposal(args, environment, parsed = null) {
    const command = parsed || this.#parseCommand(args, environment);
    if (args.prefix_rule !== undefined && !command?.segments.length) {
      throw new Error(
        'prefix_rule cannot be validated because the shell command is ambiguous or unsupported.',
      );
    }
    if (!command?.segments.length) {
      return {
        parsed: command,
        policy_kind: null,
        policy_persistable: false,
        prefix_rule: null,
      };
    }

    if (args.prefix_rule !== undefined) {
      const prefix = validatePrefixTokens(args.prefix_rule);
      if (!prefix) {
        throw new Error(
          'prefix_rule must be a non-empty bounded array of complete command tokens.',
        );
      }
      const matches = command.segments.filter((segment) =>
        tokenPrefixMatches(prefix, segment.tokens));
      if (!matches.length) {
        throw new Error(
          'prefix_rule must match at least one executable segment of the frozen command.',
        );
      }
      return {
        parsed: command,
        policy_kind: 'prefix',
        policy_persistable: true,
        prefix_rule: prefix,
      };
    }

    // A repeated identical command needs only one reusable Allow prefix.
    // Do not silently choose a broader prefix for differing segments.
    if (command.segments.every((segment) =>
      segment.tokens.length === command.segments[0].tokens.length &&
      segment.tokens.every((token, index) =>
        token === command.segments[0].tokens[index]))) {
      return {
        parsed: command,
        policy_kind: 'prefix',
        policy_persistable: true,
        prefix_rule: [...command.segments[0].tokens],
      };
    }

    // A partially authorized compound command should offer an Allow prefix
    // for its sole remaining distinct command. Requiring the model to
    // re-propose an already-identifiable prefix causes repeat approvals.
    const unmatched = command.segments.filter((segment) => {
      return this.codexPolicy?.matchSegment({
        tokens: segment.tokens,
        emit: false,
      })?.decision !== 'allow';
    });
    if (unmatched.length && unmatched.length < command.segments.length &&
        unmatched.every((segment) =>
          segment.tokens.length === unmatched[0].tokens.length &&
          segment.tokens.every((token, index) =>
            token === unmatched[0].tokens[index]))) {
      return {
        parsed: command,
        policy_kind: 'prefix',
        policy_persistable: true,
        prefix_rule: [...unmatched[0].tokens],
      };
    }

    return {
      parsed: command,
      policy_kind: null,
      policy_persistable: false,
      prefix_rule: null,
    };
  }

  async #matchTrustedPackageScript(args, workspaceHandle, environment) {
    if (!this.trustedPackageScriptStore ||
        environment.permissionProfile !== 'workspace-write' ||
        !this.trustedPackageScriptStore.mayMatch({
          workspaceHandle,
          environment,
          args,
        })) {
      return null;
    }
    try {
      const packageScript = await this.#resolvePackageScriptBinding(
        args,
        workspaceHandle,
        environment,
      );
      return this.trustedPackageScriptStore.match({
        workspaceHandle,
        environment,
        args,
        packageScript,
      });
    } catch (error) {
      this.#emit('trusted_package_script_probe_failed', {
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
        error_name: error?.name || 'Error',
      });
      return null;
    }
  }

  isSessionLive(sessionId, workspaceHandle = null) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return !workspaceHandle || session.workspaceHandle === workspaceHandle;
  }

  sessionMetadata(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      session_id: sessionId,
      operation_id: session.operationId || null,
      environment_id: session.environmentId,
      workspace_handle: session.workspaceHandle,
      ...(session.workspace || {}),
    };
  }

  async execCommand(args) {
    if (!args.workspace_handle) {
      throw new Error(
        'exec_command requires workspace_handle. Obtain one explicitly before execution.',
      );
    }
    if (args.environment_id) {
      throw new Error(
        'exec_command does not accept environment_id; workspace_handle already determines the environment.',
      );
    }
    if (!this.workspaceHandleManager) {
      throw new Error('Workspace handle manager is not available.');
    }
    const workspaceHandle = this.workspaceHandleManager.resolve(
      args.workspace_handle,
    );
    const environment = this.environmentRegistry.resolve(
      workspaceHandle.environment_id,
    );
    const administratorRequested = args.run_as_admin === true;
    if (administratorRequested && (
      environment.platform !== 'windows' ||
      environment.permissionProfile !== 'workspace-write'
    )) {
      throw new Error('run_as_admin requires a Windows workspace-write Worker with an installed administrator agent.');
    }
    if (administratorRequested && (
      (args.sandbox_permissions && args.sandbox_permissions !== 'use_default') ||
      args.prefix_rule !== undefined || args.full_access_grant_id !== undefined
    )) {
      throw new Error('run_as_admin cannot be combined with escalation, prefix_rule or a Full Access grant.');
    }
    const operationId = randomUUID();
    let forwardedArgs = {
      ...args,
      environment_id: environment.id,
      workspace_id: workspaceHandle.workspace_id,
      expected_workspace_root: workspaceHandle.workspace_root,
    };
    delete forwardedArgs.workspace_handle;
    delete forwardedArgs.prefix_rule;
    delete forwardedArgs.full_access_grant_id;
    delete forwardedArgs.run_as_admin;
    delete forwardedArgs.review_context;
    const requestedYieldMs = clampInitialExecYield(args.yield_time_ms);
    forwardedArgs = {
      ...forwardedArgs,
      yield_time_ms: requestedYieldMs,
    };
    const requestedEscalation = args.sandbox_permissions === 'require_escalated';
    const timedFullAccess = this.webFullAccess?.authorize(args.full_access_grant_id) || false;
    if (timedFullAccess && args.prefix_rule !== undefined) {
      throw new Error('Persistent prefix rules cannot be saved through timed Full Access.');
    }
    if (args.prefix_rule !== undefined && !requestedEscalation) {
      throw new Error(
        'prefix_rule is only valid with sandbox_permissions=require_escalated.',
      );
    }
    const parsedCommand = administratorRequested ? null : this.#parseCommand(args, environment);
    let explicitPolicyProposal = null;
    if (args.prefix_rule !== undefined) {
      explicitPolicyProposal = this.#persistentPolicyProposal(
        args,
        environment,
        parsedCommand,
      );
    }
    // Codex's native policy is the sole general command-rule authority.
    // It decides all parsed executable segments before the first dispatch.
    const policyRule = administratorRequested ? null :
      this.codexPolicy?.match({ parsed: parsedCommand }) || null;
    if (policyRule?.decision === 'forbidden') {
      throw new Error('Native Codex ExecPolicy forbids this command.');
    }
    const trustedPackageScriptRule = administratorRequested ? null :
      await this.#matchTrustedPackageScript(args, workspaceHandle, environment);
    const trustedPackageScript = Boolean(trustedPackageScriptRule);
    const wantsEscalation =
      (requestedEscalation || policyRule?.decision === 'prompt') &&
      !timedFullAccess &&
      !trustedPackageScript &&
      policyRule?.decision !== 'allow';

    if (trustedPackageScript) {
      forwardedArgs = {
        ...forwardedArgs,
        sandbox_permissions: 'approved_escalated',
      };
      delete forwardedArgs.justification;
      this.#emit('trusted_package_script_auto_allowed', {
        rule_id: trustedPackageScriptRule.rule_id,
        operation_id: operationId,
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
      });
    }

    if (timedFullAccess) {
      forwardedArgs = {
        ...forwardedArgs,
        sandbox_permissions: 'approved_escalated',
      };
      delete forwardedArgs.justification;
      this.#emit('web_full_access_dispatch', {
        operation_id: operationId,
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
      });
    }

    if (policyRule?.decision === 'allow') {
      forwardedArgs = {
        ...forwardedArgs,
        sandbox_permissions: 'approved_escalated',
      };
      delete forwardedArgs.justification;
      this.#emit('codex_policy_auto_allowed', {
        rule_id: policyRule.rule_id,
        rule_ids: policyRule.rule_ids,
        prefix_tokens: policyRule.prefix_tokens,
        operation_id: operationId,
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
      });
    }

    if ((administratorRequested || wantsEscalation) && environment.permissionProfile !== 'full-access') {
      if (!this.approvalManager) {
        throw new Error('Escalated execution requires an approval manager.');
      }
      const proposal = administratorRequested
        ? { prefix_rule: null, policy_kind: null, policy_persistable: false }
        : explicitPolicyProposal || this.#persistentPolicyProposal(
          args,
          environment,
          parsedCommand,
        );
      const approval = this.approvalManager.requestExecution(
        {
          ...args,
          workspace_handle: workspaceHandle.workspace_handle,
          prefix_rule: proposal.prefix_rule,
          policy_kind: proposal.policy_kind,
          policy_persistable: proposal.policy_persistable,
        },
        environment.id,
        { workspace: workspaceHandle },
      );
      if (!isReviewerTool() && this.guardianReviewer?.isEnabled?.()) {
        let assessment;
        try {
          assessment = await this.guardianReviewer.review({
            approval,
            action: {
              cmd: approval.command,
              workdir: approval.workdir,
              shell: approval.shell,
              environment_id: approval.environment_id,
              workspace_id: approval.workspace_id,
              workspace_root: approval.workspace_root,
              workspace_handle: approval.workspace_handle,
              justification: approval.justification,
              run_as_admin: approval.run_as_admin,
            },
            reviewContext: args.review_context || args.justification || '',
          });
        } catch (error) {
          this.#emit('review_fallback_human', {
            approval_id: approval.approval_id,
            intent_sha256: approval.intent_sha256,
            error_name: error?.name || 'Error',
          });
          return {
            chunk_id: 'approval', wall_time_seconds: 0,
            output: 'Guardian review could not be completed; human approval is required.',
            approval_required: true, ...approval, ...workspaceHandle,
            review_source: 'guardian', review_outcome: 'error',
          };
        }
        if (assessment?.outcome === 'deny') {
          const denied = this.approvalManager.denyReviewerExecution(
            approval.approval_id, approval.intent_sha256,
          );
          return {
            chunk_id: 'approval', wall_time_seconds: 0,
            output: 'Guardian reviewer denied this command: ' + assessment.rationale,
            approval_required: false, ...denied, ...workspaceHandle,
            review_source: 'guardian', review_outcome: 'deny',
            review_risk_level: assessment.risk_level,
          };
        }
        if (assessment?.outcome === 'allow') {
          const claimed = this.approvalManager.claimReviewerExecution(
            approval.approval_id, approval.intent_sha256,
          );
          const result = await this.#dispatchClaimedExecution({
            approvalId: approval.approval_id, claimed, decision: 'approve',
          });
          return {
            ...result, review_source: 'guardian',
            review_outcome: result.approval_required ? 'error' : 'allow',
            review_risk_level: assessment.risk_level,
          };
        }
        throw new Error('Guardian returned an invalid review outcome');
      }
      return {
        chunk_id: 'approval',
        wall_time_seconds: 0,
        output:
          administratorRequested
            ? 'Approval required before this command can run with Windows administrator permissions.'
            : 'Approval required before this command can run outside the sandbox.',
        approval_required: true,
        ...approval,
        ...(workspaceHandle || {}),
      };
    } else if (wantsEscalation) {
      forwardedArgs = {
        ...forwardedArgs,
        sandbox_permissions: 'use_default',
      };
    }

    const timeoutMs = Math.max(
      15_000,
      requestedYieldMs + 10_000,
    );
    let dispatch;
    try {
      // A grant may expire while parsing/probing policy. Recheck immediately
      // before dispatch; once started the OS process is allowed to finish.
      if (timedFullAccess) this.webFullAccess.authorize(args.full_access_grant_id);
      this.#emit('exec_dispatch', {
        operation_id: operationId,
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
      });
      dispatch = this.workerHub.call(
        environment.id,
        'exec_command',
        forwardedArgs,
        { timeoutMs },
      );
    } catch (error) {
      this.#emit('exec_dispatch_failed_prestart', {
        operation_id: operationId,
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
        error_name: error?.name || 'Error',
      });
      throw error;
    }
    let result;
    try {
      result = await dispatch;
    } catch (error) {
      this.#emit('exec_dispatch_unknown', {
        operation_id: operationId,
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
        error_name: error?.name || 'Error',
      });
      throw error;
    }
    const recorded = this.#recordExecResult(
      result,
      environment,
      workspaceHandle,
      operationId,
      Boolean(args.tty),
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
        policy_rule_ids: policyRule.rule_ids,
        policy_prefix_tokens: policyRule.prefix_tokens,
      }
      : recorded;
  }

  async resolvePendingExecution(
    { approval_id: approvalId, approval_nonce: approvalNonce, decision },
    { hostSession = null } = {},
  ) {
    if (!this.approvalManager || !this.workspaceHandleManager) {
      throw new Error('Escalated execution services are not available.');
    }
    if (decision === 'deny') {
      const denied = this.approvalManager.denyAppExecution(
        approvalId,
        approvalNonce,
        hostSession,
      );
      const workspaceHandle = this.workspaceHandleManager.resolve(
        denied.workspace_handle,
      );
      return this.#approvalStatusResult(
        denied,
        workspaceHandle,
        'The user denied this escalated command. It was not dispatched.',
      );
    }
    if (!['approve', 'approve_always'].includes(decision)) {
      throw new Error(
        'Approval decision must be approve, approve_always, or deny.',
      );
    }

    const claimed = this.approvalManager.claimAppExecution(
      approvalId,
      approvalNonce,
      hostSession,
    );
    return this.#dispatchClaimedExecution({ approvalId, claimed, decision });
  }

  async #dispatchClaimedExecution({ approvalId, claimed, decision }) {
    const action = claimed.action;
    let workspaceHandle;
    let environment;
    let persistentPolicy = null;
    let policySaveError = null;
    try {
      workspaceHandle = this.workspaceHandleManager.resolve(
        action.workspace_handle,
      );
      environment = this.environmentRegistry.resolve(
        action.environment_id,
      );
      if (workspaceHandle.environment_id !== action.environment_id ||
          workspaceHandle.workspace_id !== action.workspace_id ||
          workspaceHandle.workspace_root !== action.workspace_root) {
        throw new Error(
          'Frozen workspace identity no longer matches the current workspace handle.',
        );
      }
      if (action.run_as_admin && (
        environment.platform !== 'windows' ||
        environment.permissionProfile !== 'workspace-write'
      )) {
        throw new Error('Frozen administrator approval requires a Windows workspace-write Worker.');
      }
      if (decision === 'approve_always') {
        if (action.run_as_admin) {
          throw new Error('Administrator approval cannot be saved as an Always allow rule.');
        }
        if (!action.policy_persistable) {
          throw new Error(
            'This frozen approval does not contain a persistable policy scope.',
          );
        }
        if (action.policy_kind === 'prefix') {
          if (!this.codexPolicy) {
            throw new Error('Native Codex ExecPolicy is not available.');
          }
          if (!validatePrefixTokens(action.prefix_rule)) {
            throw new Error('Frozen prefix policy is invalid.');
          }
        } else {
          throw new Error('Frozen persistent policy kind is invalid.');
        }
      }
    } catch (error) {
      const retryable = claimed.reviewerSource
        ? this.approvalManager.returnReviewerToHuman(approvalId)
        : this.approvalManager.markAppExecutionRetryable(approvalId);
      this.#emit('approval_dispatch_failed_prestart', {
        approval_id: approvalId,
        operation_id: claimed.request.operation_id,
        environment_id: action.environment_id,
        workspace_handle: action.workspace_handle,
        workspace_id: action.workspace_id,
        error_name: error?.name || 'Error',
      });
      return this.#approvalStatusResult(
        retryable,
        workspaceHandle || {
          workspace_handle: action.workspace_handle,
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
      sandbox_permissions: action.run_as_admin ? 'admin_elevated' : 'approved_escalated',
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
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
      });
      dispatch = this.workerHub.call(
        environment.id,
        'exec_command',
        forwardedArgs,
        { timeoutMs },
      );
    } catch (error) {
      const retryable = claimed.reviewerSource
        ? this.approvalManager.returnReviewerToHuman(approvalId)
        : this.approvalManager.markAppExecutionRetryable(approvalId);
      this.#emit('approval_dispatch_failed_prestart', {
        approval_id: approvalId,
        operation_id: claimed.request.operation_id,
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
        error_name: error?.name || 'Error',
      });
      return this.#approvalStatusResult(
        retryable,
        workspaceHandle,
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
        workspace_handle: workspaceHandle.workspace_handle,
        workspace_id: workspaceHandle.workspace_id,
        error_name: error?.name || 'Error',
      });
      return this.#approvalStatusResult(
        unknown,
        workspaceHandle,
        'Escalated execution outcome is unknown; CCM will not retry automatically: ' +
          String(error?.message || error),
      );
    }

    const recorded = this.#recordExecResult(
      result,
      environment,
      workspaceHandle,
      claimed.request.operation_id,
      Boolean(action.tty),
    );
    if (decision === 'approve_always') {
      try {
        persistentPolicy = this.codexPolicy.allow({
          prefixTokens: action.prefix_rule,
        });
      } catch (error) {
        policySaveError = String(error?.message || error);
        this.#emit('exec_policy_save_failed', {
          approval_id: approvalId,
          operation_id: claimed.request.operation_id,
          environment_id: environment.id,
          workspace_handle: workspaceHandle.workspace_handle,
          workspace_id: workspaceHandle.workspace_id,
          error_name: error?.name || 'Error',
        });
      }
    }
    const consumed = this.approvalManager.markAppExecutionConsumed(approvalId);
    if (action.run_as_admin) {
      this.#emit('administrator_agent_dispatch', {
        approval_id: approvalId,
        operation_id: claimed.request.operation_id,
        environment_id: environment.id,
        workspace_handle: workspaceHandle.workspace_handle,
      });
    }
    this.#emit('approval_consumed', {
      approval_id: approvalId,
      operation_id: consumed.operation_id,
      environment_id: environment.id,
      workspace_handle: workspaceHandle.workspace_handle,
      workspace_id: workspaceHandle.workspace_id,
      public_session_id: recorded.session_id,
      exit_code: recorded.exit_code,
    });
    return {
      ...recorded,
      ...(action.run_as_admin ? { administrator_agent: true } : {}),
      approval_id: consumed.approval_id,
      state: consumed.state,
      intent_sha256: consumed.intent_sha256,
      ...(persistentPolicy ? {
        policy_saved: true,
        policy_rule_id: persistentPolicy.rule_id,
        policy_prefix_tokens: persistentPolicy.prefix_tokens,
      } : {}),
      ...(policySaveError ? {
        policy_save_failed: true,
        policy_save_error: policySaveError.slice(0, 2_000),
      } : {}),
    };
  }

  async writeStdin(args) {
    if (!args.workspace_handle) {
      throw new Error(
        'write_stdin requires workspace_handle from the exec_command result.',
      );
    }
    this.workspaceHandleManager.resolve(args.workspace_handle);
    const session = this.sessions.get(args.session_id);
    if (!session) {
      throw new Error('Unknown or expired session_id: ' + args.session_id);
    }
    if (session.workspaceHandle !== args.workspace_handle) {
      throw new Error(
        'workspace_handle does not own session_id ' + args.session_id + '.',
      );
    }

    const empty = !(args.chars || '').length;
    const requestedYield = Number(
      args.yield_time_ms ?? (empty ? 1_000 : 250),
    );
    const timeoutMs = Math.max(15_000, requestedYield + 10_000);
    const forwardedArgs = { ...args, session_id: session.remoteSessionId };
    delete forwardedArgs.workspace_handle;
    let result;
    try {
      result = await this.workerHub.call(
        session.environmentId,
        'write_stdin',
        forwardedArgs,
        { timeoutMs },
      );
    } catch (error) {
      if (
        this.sessions.get(args.session_id) === session &&
        /Unknown or expired session_id/i.test(String(error?.message || error))
      ) {
        this.sessions.delete(args.session_id);
      }
      throw error;
    }
    if (this.sessions.get(args.session_id) !== session) {
      throw new Error(
        'Session identity changed while write_stdin was in flight: ' +
        args.session_id + '.',
      );
    }
    // Short-lived echo masking applies to later ordinary model polls too.
    session.verificationEchoes = (session.verificationEchoes || [])
      .filter((entry) => entry.expiresAt > Date.now());
    if (typeof result?.output === 'string') {
      for (const entry of session.verificationEchoes) {
        result = {
          ...result,
          output: result.output.replaceAll(entry.value, '[verification input]'),
        };
      }
    }
    if (result?.session_id !== undefined) {
      this.#emit('session_continued', {
        operation_id: session.operationId || undefined,
        public_session_id: args.session_id,
        remote_session_id: session.remoteSessionId,
        environment_id: session.environmentId,
        workspace_handle: session.workspaceHandle,
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
      workspace_handle: session.workspaceHandle,
      exit_code: result?.exit_code,
    });
    return {
      ...result,
      ...(session.operationId ? { operation_id: session.operationId } : {}),
      ...(session.workspace || {}),
    };
  }

  async writeVerificationInput({ session_id, workspace_handle, value }) {
    const session = this.sessions.get(session_id);
    if (!session || session.workspaceHandle !== workspace_handle) {
      throw new Error('Unknown or mismatched live CCM process session.');
    }
    // Nothing is written to the audit log, disk, or model tool result.
    // Keep an in-memory echo mask briefly in case the PTY repeats the code
    // in a subsequent output chunk.
    const echo = {
      value,
      expiresAt: Date.now() + 2 * 60 * 1000,
    };
    session.verificationEchoes.push(echo);
    // Remove plaintext even if no subsequent session poll happens.
    const cleanup = setTimeout(() => {
      session.verificationEchoes = session.verificationEchoes.filter(
        (entry) => entry !== echo,
      );
    }, 2 * 60 * 1000);
    cleanup.unref?.();
    const result = await this.writeStdin({
      session_id,
      workspace_handle,
      chars: value + (session.tty ? '\r' : '\n'),
      yield_time_ms: 250,
      max_output_tokens: 1200,
    });
    return {
      session_running: result.session_id !== undefined,
      ...(result.exit_code !== undefined ? { exit_code: result.exit_code } : {}),
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
