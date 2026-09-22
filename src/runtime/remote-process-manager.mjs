import { isTrustedRemoteGitCommand } from './sandbox/git-policy.mjs';

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
  }) {
    if (!environmentRegistry || !workerHub) {
      throw new Error('RemoteProcessManager requires environmentRegistry and workerHub.');
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
    this.approvalManager = approvalManager;
    this.workspaceContextManager = workspaceContextManager;
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

  async execCommand(args) {
    let workspaceContext = null;
    let environment;
    let forwardedArgs;
    const contextMode = Boolean(args.workspace_context) || !args.environment_id;
    if (contextMode) {
      if (!this.workspaceContextManager) {
        throw new Error('Workspace context manager is not available.');
      }
      workspaceContext = args.workspace_context
        ? this.workspaceContextManager.resolve(args.workspace_context)
        : await this.workspaceContextManager.createProjectless();
      environment = this.environmentRegistry.resolve(
        workspaceContext.environment_id,
      );
      forwardedArgs = {
        ...args,
        environment_id: environment.id,
        workspace_id: workspaceContext.workspace_id,
      };
      delete forwardedArgs.workspace_context;
    } else {
      environment = this.environmentRegistry.resolve(args.environment_id);
      forwardedArgs = { ...args, environment_id: environment.id };
    }
    const requestedYieldMs = clampInitialExecYield(args.yield_time_ms);
    forwardedArgs = {
      ...forwardedArgs,
      yield_time_ms: requestedYieldMs,
    };
    const requestedEscalation = args.sandbox_permissions === 'require_escalated';
    const trustedGit = environment.permissionProfile === 'workspace-write' &&
      isTrustedRemoteGitCommand(args.cmd);
    const wantsEscalation = requestedEscalation && !trustedGit;

    if (requestedEscalation && trustedGit) {
      forwardedArgs = {
        ...forwardedArgs,
        sandbox_permissions: 'use_default',
      };
      delete forwardedArgs.approval_id;
      delete forwardedArgs.justification;
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
      if (!args.approval_id) {
        const approval = this.approvalManager.requestExecution(
          {
            ...args,
            ...(workspaceContext
              ? { workspace_context: workspaceContext.workspace_context }
              : {}),
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
      }

      this.approvalManager.consumeExecution(
        args.approval_id,
        {
          ...args,
          ...(workspaceContext
            ? { workspace_context: workspaceContext.workspace_context }
            : {}),
        },
        environment.id,
      );
      forwardedArgs = {
        ...forwardedArgs,
        sandbox_permissions: 'approved_escalated',
      };
      delete forwardedArgs.approval_id;
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
    const result = await this.workerHub.call(
      environment.id,
      'exec_command',
      forwardedArgs,
      { timeoutMs },
    );
    if (result?.session_id !== undefined) {
      const publicSessionId = this.#allocateSessionId();
      this.sessions.set(publicSessionId, {
        environmentId: environment.id,
        remoteSessionId: result.session_id,
        workspaceContext: workspaceContext?.workspace_context || null,
      });
      return {
        ...result,
        session_id: publicSessionId,
        ...(workspaceContext || {}),
      };
    }
    return { ...result, ...(workspaceContext || {}) };
  }

  async writeStdin(args) {
    const session = this.sessions.get(args.session_id);
    if (!session) {
      throw new Error('Unknown or expired session_id: ' + args.session_id);
    }

    const empty = !(args.chars || '').length;
    const requestedYield = Number(
      args.yield_time_ms ?? (empty ? 1_000 : 250),
    );
    const timeoutMs = Math.max(15_000, requestedYield + 10_000);
    const result = await this.workerHub.call(
      session.environmentId,
      'write_stdin',
      { ...args, session_id: session.remoteSessionId },
      { timeoutMs },
    );
    if (result?.session_id !== undefined) {
      return { ...result, session_id: args.session_id };
    }

    this.sessions.delete(args.session_id);
    return result;
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
