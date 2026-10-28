import { MAX_WORKER_MESSAGE_BYTES } from './protocol.mjs';

const pending = new WeakMap();

export function sendWorkerMessage(socket, message) {
  if (!socket) return Promise.reject(new Error('WorkerHub connection is closed.'));
  const payload = JSON.stringify(message) + '\n';
  if (Buffer.byteLength(payload, 'utf8') > MAX_WORKER_MESSAGE_BYTES) {
    return Promise.reject(new Error('WorkerHub message exceeds size limit.'));
  }
  const send = () => new Promise((resolve, reject) => {
    if (socket.destroyed || !socket.writable) {
      reject(new Error('WorkerHub connection is closed.'));
      return;
    }
    if (socket.write(payload)) { resolve(); return; }
    const cleanup = () => {
      socket.off('drain', onDrain);
      socket.off('close', onClose);
      socket.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('WorkerHub connection closed while sending.')); };
    const onError = error => { cleanup(); reject(error); };
    socket.once('drain', onDrain);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
  const previous = pending.get(socket);
  const current = previous ? previous.catch(() => {}).then(send) : send();
  pending.set(socket, current);
  current.then(() => {
    if (pending.get(socket) === current) pending.delete(socket);
  }, () => {
    if (pending.get(socket) === current) pending.delete(socket);
  });
  return current;
}
