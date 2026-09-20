export class RemoteProcessManager {
  constructor({ environmentRegistry, workerHub }) {
    if (!environmentRegistry || !workerHub) {
      throw new Error('RemoteProcessManager requires environmentRegistry and workerHub.');
    }
    this.environmentRegistry = environmentRegistry;
    this.workerHub = workerHub;
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
    const environment = this.environmentRegistry.resolve(args.environment_id);
    const timeoutMs = Math.max(
      35_000,
      Number(args.yield_time_ms || 10_000) + 10_000,
    );
    const result = await this.workerHub.call(
      environment.id,
      'exec_command',
      { ...args, environment_id: environment.id },
      { timeoutMs },
    );
    if (result?.session_id !== undefined) {
      const publicSessionId = this.#allocateSessionId();
      this.sessions.set(publicSessionId, {
        environmentId: environment.id,
        remoteSessionId: result.session_id,
      });
      return { ...result, session_id: publicSessionId };
    }
    return result;
  }

  async writeStdin(args) {
    const session = this.sessions.get(args.session_id);
    if (!session) {
      throw new Error('Unknown or expired session_id: ' + args.session_id);
    }

    const empty = !(args.chars || '').length;
    const requestedYield = Number(
      args.yield_time_ms ?? (empty ? 5_000 : 250),
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
