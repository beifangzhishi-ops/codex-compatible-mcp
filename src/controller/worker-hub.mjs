import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  MAX_WORKER_MESSAGE_BYTES,
  WORKER_PROTOCOL,
} from '../worker/protocol.mjs';

function send(socket, message) {
  socket.write(JSON.stringify(message) + '\n');
}

export class WorkerHub extends EventEmitter {
  constructor({
    environmentRegistry,
    host = process.env.CCM_WORKER_HUB_BIND_HOST || '127.0.0.1',
    port = Number(process.env.CCM_WORKER_HUB_PORT || 18301),
    requestTimeoutMs = 30_000,
    takeoverToken = null,
    quarantinePolicy = null,
  } = {}) {
    super();
    if (!environmentRegistry) throw new Error('WorkerHub requires an environment registry.');
    this.environmentRegistry = environmentRegistry;
    this.host = host;
    this.port = port;
    this.requestTimeoutMs = requestTimeoutMs;
    this.takeoverToken = takeoverToken ? String(takeoverToken) : null;
    this.quarantinePolicy = quarantinePolicy;
    this.server = null;
    this.connections = new Map();
    this.environmentOwners = new Map();
  }

  get address() {
    return this.server?.address() || null;
  }
  async start() {
    if (this.server) return this.server;
    this.server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
    return this.server;
  }

  listStatus() {
    return [...this.connections.values()].map((connection) => ({
      worker_id: connection.workerId,
      environments: [...connection.environmentIds],
      remote_address: connection.socket.remoteAddress,
      ...this.#connectionStatus(connection),
    }));
  }
  environmentStatus(environmentId) {
    const workerId = this.environmentOwners.get(environmentId);
    const connection = workerId ? this.connections.get(workerId) : null;
    if (!connection) {
      return {
        state: 'unavailable',
        abnormal_reason: 'No connected Remote Worker owns this environment.',
      };
    }
    return this.#connectionStatus(connection);
  }
  quarantine(environmentId, code, reason) {
    const workerId = this.environmentOwners.get(environmentId);
    const connection = workerId ? this.connections.get(workerId) : null;
    if (!connection) return false;
    this.#quarantineConnection(connection, code, reason);
    return true;
  }
  async waitForEnvironment(environmentId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.environmentOwners.has(environmentId)) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  call(environmentId, method, params = {}, { timeoutMs } = {}) {
    const workerId = this.environmentOwners.get(environmentId);
    const connection = workerId ? this.connections.get(workerId) : null;
    if (!connection) {
      throw new Error('No connected Remote Worker owns environment: ' + environmentId);
    }
    if (connection.quarantine) {
      const error = new Error(
        'Remote Worker is quarantined for environment ' + environmentId +
        ': ' + connection.quarantine.reason,
      );
      error.code = 'worker_quarantined';
      error.worker_id = connection.workerId;
      error.environment_id = environmentId;
      error.quarantine_code = connection.quarantine.code;
      throw error;
    }

    const id = randomUUID();
    const waitMs = Number(timeoutMs || this.requestTimeoutMs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new Error('Remote Worker request timed out: ' + method));
      }, waitMs);
      connection.pending.set(id, { resolve, reject, timer });
      send(connection.socket, { type: 'request', id, method, params });
    });
  }
  async close() {
    for (const connection of this.connections.values()) {
      this.#removeConnection(connection, new Error('WorkerHub closed.'));
      connection.socket.destroy();
    }
    this.connections.clear();
    this.environmentOwners.clear();

    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  #accept(socket) {
    const connection = {
      socket,
      workerId: null,
      environmentIds: new Set(),
      pending: new Map(),
      buffer: '',
      quarantine: null,
    };

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#consume(connection, chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      this.#removeConnection(connection, new Error('Remote Worker disconnected.'));
    });
  }
  #consume(connection, chunk) {
    connection.buffer += chunk;
    while (true) {
      const newline = connection.buffer.indexOf('\n');
      if (newline < 0) {
        if (Buffer.byteLength(connection.buffer, 'utf8') > MAX_WORKER_MESSAGE_BYTES) {
          connection.socket.destroy(new Error('Remote Worker message exceeds size limit.'));
        }
        break;
      }
      const line = connection.buffer.slice(0, newline).trim();
      connection.buffer = connection.buffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_WORKER_MESSAGE_BYTES) {
        connection.socket.destroy(new Error('Remote Worker message exceeds size limit.'));
        return;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        connection.socket.destroy(new Error('Invalid worker JSON message.'));
        return;
      }
      this.#onMessage(connection, message);
    }
  }

  #onMessage(connection, message) {
    if (message?.type === 'hello') {
      this.#registerHello(connection, message);
      return;
    }
    if (message?.type !== 'response' || !message.id) return;

    const pending = connection.pending.get(message.id);
    if (!pending) return;
    connection.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(String(message.error.message || message.error));
      if (message.error.code) error.code = String(message.error.code);
      if (error.code && this.quarantinePolicy?.has(error.code)) {
        this.#quarantineConnection(connection, error.code, error.message);
      }
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  #registerHello(connection, message) {
    if (message.protocol !== WORKER_PROTOCOL || !message.worker_id) {
      send(connection.socket, {
        type: 'hello_error',
        message: 'Unsupported or invalid worker hello.',
      });
      connection.socket.destroy();
      return;
    }

    const environments = Array.isArray(message.environments)
      ? message.environments
      : [];
    if (environments.length === 0) {
      send(connection.socket, {
        type: 'hello_error',
        message: 'Worker must advertise at least one environment.',
      });
      connection.socket.destroy();
      return;
    }

    const workerId = String(message.worker_id);
    const previous = this.connections.get(workerId);
    if (previous && previous !== connection) {
      const quarantinedReplacement = Boolean(previous.quarantine);
      const authorizedTakeover = Boolean(
        this.takeoverToken &&
        message.takeover_token &&
        String(message.takeover_token) === this.takeoverToken,
      );
      if (!authorizedTakeover && !quarantinedReplacement) {
        send(connection.socket, {
          type: 'hello_error',
          code: 'duplicate_worker_id',
          message: 'Remote Worker id is already connected: ' + workerId + '.',
        });
        connection.socket.destroy();
        return;
      }

      this.#removeConnection(
        previous,
        new Error(
          quarantinedReplacement
            ? 'Quarantined Remote Worker connection superseded by fresh worker.'
            : 'Remote Worker connection superseded by controller-owned worker.',
        ),
      );
      previous.socket.destroy();
    }

    for (const environment of environments) {
      const environmentId = String(environment.id || '');
      if (!environmentId) {
        send(connection.socket, {
          type: 'hello_error',
          code: 'invalid_environment_id',
          message: 'Worker environment id is required.',
        });
        connection.socket.destroy();
        return;
      }

      const owner = this.environmentOwners.get(environmentId);
      if (owner && owner !== workerId) {
        send(connection.socket, {
          type: 'hello_error',
          code: 'environment_already_owned',
          message:
            'Environment ' + environmentId +
            ' is already owned by worker ' + owner + '.',
        });
        connection.socket.destroy();
        return;
      }
    }

    connection.workerId = workerId;
    this.connections.set(workerId, connection);

    try {
      for (const environment of environments) {
        const environmentId = String(environment.id || '');

        this.environmentRegistry.unregister(environmentId);
        this.environmentRegistry.register({
          ...environment,
          id: environmentId,
          backend: 'remote-worker',
          metadata: { ...(environment.metadata || {}), workerId },
        });
        this.environmentOwners.set(environmentId, workerId);
        connection.environmentIds.add(environmentId);
        this.emit('environment_connected', environmentId, workerId);
      }
      send(connection.socket, {
        type: 'hello_ack',
        protocol: WORKER_PROTOCOL,
        worker_id: workerId,
      });
    } catch (error) {
      this.#removeConnection(connection, error);
      send(connection.socket, {
        type: 'hello_error',
        code: 'worker_registration_failed',
        message: String(error?.message || error),
      });
      connection.socket.destroy();
    }
  }

  #removeConnection(connection, reason) {
    for (const [id, pending] of connection.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      connection.pending.delete(id);
    }

    if (connection.workerId &&
        this.connections.get(connection.workerId) === connection) {
      this.connections.delete(connection.workerId);
      for (const environmentId of connection.environmentIds) {
        if (this.environmentOwners.get(environmentId) !== connection.workerId) continue;
        this.environmentOwners.delete(environmentId);
        this.environmentRegistry.unregister(environmentId);
        this.emit('environment_disconnected', environmentId, connection.workerId);
      }
    }
  }

  #connectionStatus(connection) {
    if (!connection?.quarantine) return { state: 'normal' };
    return {
      state: 'abnormal',
      abnormal_code: connection.quarantine.code,
      abnormal_reason: connection.quarantine.reason,
      abnormal_since: connection.quarantine.since,
    };
  }

  #quarantineConnection(connection, code, reason) {
    const next = {
      code: String(code || 'worker_contract_error'),
      reason: String(reason || 'Remote Worker contract failure.'),
      since: new Date().toISOString(),
    };
    connection.quarantine = next;
    this.emit('worker_quarantined', connection.workerId, {
      ...next,
      environments: [...connection.environmentIds],
    });
  }
}
