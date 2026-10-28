import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TRANSFER_CHUNK_BYTES } from '../runtime/filesystem/transfer-worker.mjs';

const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const CHUNK_RPC_TIMEOUT_MS = 120_000;
const MAX_ACTIVE_TASKS = 2;

function checkCancelled(task) {
  if (task.cancel) throw new Error('Transfer cancelled.');
}
function view(task) {
  return {
    transfer_id: task.id, state: task.state, source_handle: task.sourceHandle,
    target_handle: task.targetHandle, source_path: task.sourcePath,
    target_path: task.targetPath, total_bytes: task.totalBytes,
    transferred_bytes: task.transferredBytes, file_count: task.fileCount,
    completed_files: task.completedFiles, created_at: task.createdAt,
    ...(task.finishedAt ? { finished_at: task.finishedAt } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.residue?.length ? { residue: task.residue } : {}),
  };
}

export class TransferTaskManager {
  constructor({ workspaceHandleManager, workerHub, stateFile = null }) {
    this.workspaceHandleManager = workspaceHandleManager;
    this.workerHub = workerHub;
    this.tasks = new Map();
    this.stateFile = stateFile;
    if (stateFile && fs.existsSync(stateFile)) {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      for (const value of saved.tasks || []) {
        if (!value?.transfer_id) continue;
        const interrupted = !['completed', 'failed', 'cancelled'].includes(value.state);
        const task = {
          id: value.transfer_id, state: interrupted ? 'failed' : value.state,
          sourceHandle: value.source_handle, targetHandle: value.target_handle,
          sourcePath: value.source_path, targetPath: value.target_path,
          totalBytes: value.total_bytes, transferredBytes: value.transferred_bytes,
          fileCount: value.file_count, completedFiles: value.completed_files,
          createdAt: value.created_at,
          finishedAt: interrupted ? new Date().toISOString() : value.finished_at,
          error: interrupted ? 'Controller restarted during transfer; destination may require manual cleanup.' : value.error,
          residue: interrupted ? [value.target_path] : value.residue || [],
        };
        this.tasks.set(task.id, task);
      }
      this.#persist();
    }
  }
  #persist() {
    if (!this.stateFile) return;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temp = this.stateFile + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify({
        version: 1, tasks: [...this.tasks.values()].map(view),
      }) + '\n', { flag: 'wx' });
      fs.renameSync(temp, this.stateFile);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
  start(args) {
    if (typeof args.source_path !== 'string' || !args.source_path ||
        typeof args.target_path !== 'string' || !args.target_path) {
      throw new Error('Transfer source_path and target_path are required.');
    }
    const source = this.workspaceHandleManager.resolve(args.source_handle);
    const target = this.workspaceHandleManager.resolve(args.target_handle);
    if (source.environment_id === target.environment_id &&
        path.resolve(source.workspace_root, args.source_path).toLowerCase() ===
        path.resolve(target.workspace_root, args.target_path).toLowerCase()) {
      throw new Error('Transfer source and target must differ.');
    }
    for (const [id, task] of this.tasks) {
      if (task.finishedAt && Date.now() - new Date(task.finishedAt).getTime() > RESULT_TTL_MS) this.tasks.delete(id);
    }
    if ([...this.tasks.values()].filter(t => !t.finishedAt).length >= MAX_ACTIVE_TASKS) {
      throw new Error('Too many active transfers.');
    }
    const id = crypto.randomUUID();
    const task = {
      id, source, target, sourceHandle: args.source_handle,
      targetHandle: args.target_handle, sourcePath: args.source_path,
      targetPath: args.target_path, state: 'reserving', cancel: false,
      createdAt: new Date().toISOString(), totalBytes: 0, transferredBytes: 0,
      fileCount: 0, completedFiles: 0, residue: [],
    };
    this.tasks.set(id, task);
    this.#persist();
    task.promise = this.#run(task).catch(() => {});
    return view(task);
  }
  status(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown transfer_id.');
    if (task.finishedAt && Date.now() - new Date(task.finishedAt).getTime() > RESULT_TTL_MS) {
      this.tasks.delete(id);
      this.#persist();
      throw new Error('Transfer result has expired.');
    }
    return view(task);
  }
  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('Unknown transfer_id.');
    if (!task.finishedAt) task.cancel = true;
    this.#persist();
    return view(task);
  }
  async close() {
    for (const task of this.tasks.values()) if (!task.finishedAt) task.cancel = true;
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([...this.tasks.values()].filter(t => t.promise).map(t => t.promise)),
        new Promise(resolve => { timer = setTimeout(resolve, 10_000); timer.unref?.(); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async #run(task) {
    let reserveAttempted = false;
    const base = ctx => ({
      workspace_id: ctx.workspace_id,
      expected_workspace_root: ctx.workspace_root,
    });
    const invoke = (ctx, method, args, timeoutMs = CHUNK_RPC_TIMEOUT_MS) =>
      this.workerHub.call(ctx.environment_id, method, args, { timeoutMs });
    const source = task.source;
    const target = task.target;
    try {
      const inspected = await invoke(source, 'transfer_inspect',
        { ...base(source), source_path: task.sourcePath });
      checkCancelled(task);
      if (!inspected.entries?.length) throw new Error('Empty source manifest.');
      if (source.environment_id === target.environment_id &&
          inspected.kind === 'dir' &&
          path.resolve(target.workspace_root, task.targetPath).toLowerCase()
            .startsWith(path.resolve(inspected.source_path).toLowerCase() + path.sep)) {
        throw new Error('Cannot copy directory into itself.');
      }
      task.totalBytes = inspected.entries.filter(e => e.type === 'file')
        .reduce((total, e) => total + e.size, 0);
      task.fileCount = inspected.entries.filter(e => e.type === 'file').length;
      this.#persist();
      checkCancelled(task);
      reserveAttempted = true;
      await invoke(target, 'transfer_reserve', {
        ...base(target), transfer_id: task.id,
        target_path: task.targetPath, kind: inspected.kind, entries: inspected.entries,
      });
      task.state = 'transferring';
      this.#persist();
      for (const [index, entry] of inspected.entries.entries()) {
        if (entry.type !== 'file') continue;
        let offset = 0;
        while (offset < entry.size) {
          checkCancelled(task);
          const length = Math.min(TRANSFER_CHUNK_BYTES, entry.size - offset);
          const chunk = await invoke(source, 'transfer_read', {
            ...base(source), source_path: task.sourcePath,
            relative: entry.path, offset, length, size: entry.size,
            mtime_ms: entry.mtime_ms,
          });
          checkCancelled(task);
          if (chunk.byte_length !== length) throw new Error('Source transfer chunk length mismatch.');
          const accepted = await invoke(target, 'transfer_write', {
            transfer_id: task.id, index, offset, data: chunk.data,
          });
          if (accepted.offset !== offset + length) throw new Error('Target transfer offset mismatch.');
          offset += length;
          task.transferredBytes += length;
          this.#persist();
        }
        checkCancelled(task);
        const digest = await invoke(source, 'transfer_digest', {
          ...base(source), source_path: task.sourcePath, relative: entry.path,
          size: entry.size, mtime_ms: entry.mtime_ms,
        }, 600_000);
        await invoke(target, 'transfer_finish', {
          transfer_id: task.id, index, sha256: digest.sha256,
        }, 600_000);
        task.completedFiles++;
      }
      checkCancelled(task);
      await invoke(target, 'transfer_commit', { transfer_id: task.id });
      reserveAttempted = false;
      task.state = 'completed';
    } catch (error) {
      task.state = task.cancel ? 'cancelled' : 'failed';
      task.error = String(error?.message || error);
      if (reserveAttempted) {
        try {
          const result = await invoke(target, 'transfer_abort', { transfer_id: task.id }, 30_000);
          task.residue = result.residue || [];
        } catch (cleanupError) {
          task.residue = [path.resolve(target.workspace_root, task.targetPath)];
          task.error += ' (cleanup unavailable: ' + String(cleanupError?.message || cleanupError) + ')';
        }
      }
    } finally {
      task.finishedAt = new Date().toISOString();
      this.#persist();
    }
  }
}
