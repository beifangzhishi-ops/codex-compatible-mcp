import { randomUUID } from 'node:crypto';

// Only routing metadata lives here. Verification input is handed straight to
// the live Worker session and is never recorded on the request.
export class VerificationInputManager {
  constructor({ processManager }) {
    this.processManager = processManager;
    this.requests = new Map();
  }

  #prune() {
    const cutoff = Date.now() - 4 * 60 * 60 * 1000;
    for (const [id, request] of this.requests) {
      if (request.createdAt < cutoff) this.requests.delete(id);
    }
  }

  #get(requestId, hostSession = null) {
    this.#prune();
    const request = this.requests.get(requestId);
    if (!request) throw new Error('Verification input card is no longer available.');
    if (request.hostSession && hostSession &&
        request.hostSession !== hostSession) {
      throw new Error('Verification input card belongs to another Host session.');
    }
    return request;
  }

  #snapshot(request) {
    return {
      request_id: request.id,
      session_id: request.sessionId,
      environment_id: request.environmentId,
      workspace_id: request.workspaceId,
      label: request.label,
      state: request.state,
      ...(request.sessionRunning !== undefined
        ? { session_running: request.sessionRunning } : {}),
      ...(request.exitCode !== undefined ? { exit_code: request.exitCode } : {}),
    };
  }

  create({ workspaceHandle, sessionId, label = 'Verification code', hostSession = null }) {
    this.#prune();
    const session = this.processManager.sessionMetadata(sessionId);
    if (!session || session.workspace_handle !== workspaceHandle ||
        !this.processManager.isSessionLive(sessionId, workspaceHandle)) {
      throw new Error('No live CCM process session belongs to this workspace_handle and session_id.');
    }
    const request = {
      id: randomUUID(),
      sessionId,
      workspaceHandle,
      environmentId: session.environment_id,
      workspaceId: session.workspace_id,
      label: String(label).slice(0, 100),
      hostSession,
      state: 'pending',
      createdAt: Date.now(),
    };
    this.requests.set(request.id, request);
    return this.#snapshot(request);
  }

  status(requestId, { hostSession = null } = {}) {
    const request = this.#get(requestId, hostSession);
    if (request.state === 'pending' &&
        !this.processManager.isSessionLive(request.sessionId, request.workspaceHandle)) {
      request.state = 'unavailable';
    }
    return this.#snapshot(request);
  }

  async submit(requestId, value, { hostSession = null } = {}) {
    const request = this.#get(requestId, hostSession);
    if (request.state !== 'pending') return this.#snapshot(request);
    if (!this.processManager.isSessionLive(request.sessionId, request.workspaceHandle)) {
      request.state = 'unavailable';
      return this.#snapshot(request);
    }
    // Claim before awaiting Worker I/O: two cards must not inject the same
    // input twice. On an uncertain delivery, require a fresh user request.
    request.state = 'sending';
    try {
      const result = await this.processManager.writeVerificationInput({
        session_id: request.sessionId,
        workspace_handle: request.workspaceHandle,
        value,
      });
      request.state = 'delivered';
      request.sessionRunning = result.session_running;
      if (result.exit_code !== undefined) request.exitCode = result.exit_code;
    } catch {
      request.state = 'unknown';
    }
    return this.#snapshot(request);
  }

  close() {
    this.requests.clear();
  }
}
