import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CCM_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const ADMIN_KEY_FILE = path.join(CCM_ROOT, '.state', 'admin-agent.key');
export const MAX_ADMIN_FRAME = 8 * 1024 * 1024;

export function adminPipeName(root = CCM_ROOT) {
  const digest = crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ccm-admin-${digest}`
    : path.join(root, '.state', `ccm-admin-${digest}.sock`);
}

export function pipeFrames(onFrame, onError) {
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

export function sendPipeFrame(socket, message) {
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
