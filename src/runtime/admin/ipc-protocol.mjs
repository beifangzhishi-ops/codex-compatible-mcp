import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CCM_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const ADMIN_KEY_FILE = path.join(CCM_ROOT, '.state', 'admin-agent.key');
export const ADMIN_ENDPOINT_FILE = path.join(CCM_ROOT, '.state', 'admin-agent-endpoint.json');
export const ADMIN_LOOPBACK_HOST = '127.0.0.1';
export const MAX_ADMIN_FRAME = 8 * 1024 * 1024;

export function validateAdminEndpoint(endpoint) {
  if (endpoint?.host !== ADMIN_LOOPBACK_HOST ||
      !Number.isInteger(endpoint?.port) || endpoint.port < 1 || endpoint.port > 65535) {
    throw new Error('Invalid CCM administrator agent loopback endpoint.');
  }
  return { host: ADMIN_LOOPBACK_HOST, port: endpoint.port };
}

export function decodeFrames(onFrame, onError) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > MAX_ADMIN_FRAME) {
      onError(new Error('CCM administrator IPC frame exceeds size limit.'));
      return;
    }
    let newline;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      try {
        onFrame(JSON.parse(line));
      } catch (error) {
        onError(error);
        return;
      }
    }
  };
}

export function sendFrame(socket, message) {
  if (!socket.destroyed && socket.writable) {
    socket.write(JSON.stringify(message) + '\n');
  }
}

export function compareAdminKey(expected, provided) {
  if (typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided)) return false;
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
