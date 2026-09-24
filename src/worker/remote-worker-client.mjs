import net from 'node:net';
import {
  MAX_WORKER_MESSAGE_BYTES,
  WORKER_PROTOCOL,
} from './protocol.mjs';

function send(socket, message) {
  socket.write(JSON.stringify(message) + '\n');
}

class RemoteWorkerDispatchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemoteWorkerDispatchError';
    this.code = code;
  }
}

function environmentDescriptor(runtime) {
  const environment = runtime.environmentRegistry.resolve();
  return {
    id: environment.id,
    name: environment.name,
    platform: environment.platform,
    cwd: environment.cwd,
    workspaceRoots: environment.workspaceRoots,
    shell: environment.shell,
    permissionProfile: environment.permissionProfile,
    capabilities: environment.capabilities,
  };
}

export class RemoteWorkerHandshakeError extends Error {
  constructor(message, code = 'worker_hello_rejected') {
    super(message);
    this.name = 'RemoteWorkerHandshakeError';
    this.code = code;
  }
}

export class RemoteWorkerClient {
  constructor({
    runtime,
    workerId,
    takeoverToken = process.env.CCM_WORKER_TAKEOVER_TOKEN || null,
    host = process.env.CCM_WORKER_HUB_CONNECT_HOST || '127.0.0.1',
    port = Number(process.env.CCM_WORKER_HUB_PORT || 18301),
    handshakeTimeoutMs = Number(
      process.env.CCM_WORKER_HANDSHAKE_TIMEOUT_MS || 10_000,
    ),
  } = {}) {
    if (!runtime) throw new Error('RemoteWorkerClient requires a worker runtime.');
    this.runtime = runtime;
    const environment = environmentDescriptor(runtime);
    this.workerId = String(workerId || process.env.CCM_WORKER_ID || environment.id);
    this.takeoverToken = takeoverToken ? String(takeoverToken) : null;
    this.host = host;
    this.port = port;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.socket = null;
    this.buffer = '';
    this.connected = false;
    this.closedPromise = null;
    this.closedResolve = null;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    this.closedPromise = new Promise((resolve) => {
      this.closedResolve = resolve;
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10_000);
      socket.setEncoding('utf8');

      const finish = (callback, value) => {
        if (!settled) {
          settled = true;
          clearTimeout(handshakeTimer);
          callback(value);
        }
      };
      const fail = (error) => finish(reject, error);
      const succeed = () => finish(resolve);
      const handshakeTimer = setTimeout(() => {
        fail(new Error(
          'Remote Worker hello_ack timed out after ' +
          this.handshakeTimeoutMs + ' ms.',
        ));
        socket.destroy();
      }, this.handshakeTimeoutMs);
      socket.on('connect', () => {
        send(socket, {
          type: 'hello',
          protocol: WORKER_PROTOCOL,
          worker_id: this.workerId,
          ...(this.takeoverToken
            ? { takeover_token: this.takeoverToken }
            : {}),
          environments: [environmentDescriptor(this.runtime)],
        });
      });
      socket.on('data', (chunk) => {
        this.#consume(chunk, (message) => {
          if (message?.type === 'hello_ack') {
            this.connected = true;
            succeed();
            return;
          }
          if (message?.type === 'hello_error') {
            fail(new RemoteWorkerHandshakeError(
              String(message.message || 'Worker hello rejected.'),
              String(message.code || 'worker_hello_rejected'),
            ));
            socket.destroy();
            return;
          }
          this.#onMessage(message).catch(() => {});
        });
      });
      socket.on('error', fail);
      socket.on('close', () => {
        this.connected = false;
        if (!settled) {
          fail(new Error('Remote Worker connection closed before hello_ack.'));
        }
        this.closedResolve?.();
      });
    });
  }

  async waitUntilClosed() {
    await this.closedPromise;
  }

  async close() {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    if (socket && !socket.destroyed) socket.destroy();
    await this.closedPromise?.catch(() => {});
  }

  #consume(chunk, onMessage) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) {
        if (Buffer.byteLength(this.buffer, 'utf8') > MAX_WORKER_MESSAGE_BYTES) {
          this.socket?.destroy(new Error('Controller message exceeds size limit.'));
        }
        break;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_WORKER_MESSAGE_BYTES) {
        this.socket?.destroy(new Error('Controller message exceeds size limit.'));
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.socket?.destroy(new Error('Invalid controller JSON message.'));
        return;
      }
      onMessage(message);
    }
  }

  async #onMessage(message) {
    if (message?.type !== 'request' || !message.id) return;
    try {
      const result = await this.#dispatch(message.method, message.params || {});
      send(this.socket, {
        type: 'response',
        id: message.id,
        result,
      });
    } catch (error) {
      send(this.socket, {
        type: 'response',
        id: message.id,
        error: {
          ...(error?.code ? { code: String(error.code) } : {}),
          message: String(error?.message || error),
        },
      });
    }
  }

  async #dispatch(method, params) {
    switch (method) {
      case 'ping':
        return { ok: true, worker_id: this.workerId };
      case 'exec_command':
        return this.runtime.processManager.execCommand(params);
      case 'write_stdin':
        return this.runtime.processManager.writeStdin(params);
      case 'apply_patch':
        return this.runtime.fileService.applyPatch(params);
      case 'view_image':
        return this.runtime.fileService.viewImage(params);
      case 'send_file':
        return this.runtime.fileService.sendFile(params);
      case 'receive_file':
        return this.runtime.fileService.receiveFile(params);
      case 'list_projects':
        return {
          projects: this.runtime.workspaceRegistry.listRegistered().map(
            (workspace) => ({
              project_id: workspace.workspace_id,
              root: workspace.root,
              created_at: workspace.created_at,
            }),
          ),
          ...(params.all
            ? {
                projectless_contexts:
                  this.runtime.workspaceRegistry.listProjectless().map(
                    (workspace) => ({
                      projectless_id: workspace.workspace_id,
                      root: workspace.root,
                      created_at: workspace.created_at,
                    }),
                  ),
              }
            : {}),
        };
      case 'get_workspace':
        return this.runtime.workspaceRegistry.resolve(params.workspace_id);
      case 'inspect_workspace_path':
        return this.runtime.workspaceRegistry.inspectPath(
          params.path,
          params.workspace_id,
          { createIfMissing: Boolean(params.create_if_missing) },
        );
      case 'register_workspace':
        return this.runtime.workspaceRegistry.register(params);
      case 'create_projectless_workspace':
        return this.runtime.workspaceRegistry.createProjectless();
      case 'terminate_session':
        return {
          terminated: this.runtime.processManager.terminateSession(
            params.session_id,
          ),
        };
      default:
        throw new RemoteWorkerDispatchError(
          'unknown_method',
          'Unknown Remote Worker method: ' + method,
        );
    }
  }
}
