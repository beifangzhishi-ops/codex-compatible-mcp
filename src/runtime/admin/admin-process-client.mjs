import fs from 'node:fs';
import net from 'node:net';
import {
  ADMIN_KEY_FILE, ADMIN_ENDPOINT_FILE, decodeFrames, sendFrame, validateAdminEndpoint,
} from './ipc-protocol.mjs';

// One loopback connection owns one child. The ordinary Worker never receives an
// administrator token, and a missing or disconnected agent fails closed.
export class AdministratorProcessClient {
  constructor({
    keyFile = ADMIN_KEY_FILE,
    endpointFile = ADMIN_ENDPOINT_FILE,
    endpoint = null,
    connect = net.createConnection,
  } = {}) {
    this.keyFile = keyFile;
    this.endpointFile = endpointFile;
    this.endpoint = endpoint;
    this.connect = connect;
  }

  startProcess({ file, args, cwd, env, onData, onExit }) {
    let key;
    try {
      key = fs.readFileSync(this.keyFile, 'utf8').trim();
    } catch {
      throw new Error('CCM administrator agent is not installed: missing local IPC key.');
    }
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid CCM administrator agent IPC key.');

    let endpoint;
    try {
      endpoint = validateAdminEndpoint(
        this.endpoint ?? JSON.parse(fs.readFileSync(this.endpointFile, 'utf8')),
      );
    } catch {
      throw new Error('CCM administrator agent is unavailable: invalid or missing loopback endpoint.');
    }
    const socket = this.connect(endpoint);
    socket.setNoDelay?.(true);
    let started = false;
    let completed = false;
    const pendingInput = [];
    const finish = (exitCode, detail) => {
      if (completed) return;
      completed = true;
      if (detail) onData(`CCM administrator agent: ${detail}\n`);
      onExit(exitCode, null);
      socket.end();
    };
    socket.once('connect', () => sendFrame(socket, {
      type: 'start', key, file, args, cwd,
      // Never forward Controller/Worker bootstrap credentials into an elevated command.
      env: Object.fromEntries(Object.entries(env).filter(([name]) => !/^CCM_/i.test(name))),
    }));
    socket.on('data', decodeFrames((frame) => {
      if (frame?.type === 'started') {
        started = true;
        for (const chars of pendingInput) sendFrame(socket, { type: 'input', data: chars });
        pendingInput.length = 0;
      } else if (frame?.type === 'output' && typeof frame.data === 'string') {
        onData(Buffer.from(frame.data, 'base64'));
      } else if (frame?.type === 'exit') {
        finish(Number.isInteger(frame.code) ? frame.code : 1);
      } else if (frame?.type === 'error') {
        finish(125, String(frame.message || 'unknown agent error'));
      }
    }, (error) => finish(125, error.message)));
    socket.on('error', (error) => finish(125, `connection unavailable (${error.code || error.message})`));
    socket.on('close', () => finish(125, 'connection closed before process exit'));

    return {
      sandboxed: false,
      get stdinWritable() { return !completed && socket.writable; },
      write(chars) {
        if (completed) throw new Error('Administrator command already exited.');
        const data = Buffer.from(chars, 'utf8').toString('base64');
        if (started) sendFrame(socket, { type: 'input', data });
        else pendingInput.push(data);
      },
      kill() {
        if (completed) return;
        if (started) sendFrame(socket, { type: 'kill' });
        socket.end();
      },
    };
  }
}
