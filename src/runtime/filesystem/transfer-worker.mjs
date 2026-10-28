import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveWorkspaceRelativePath } from '../workspace-registry.mjs';

export const TRANSFER_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

function guardedStat(target, root = null) {
  const full = path.resolve(target);
  const stop = root && path.resolve(root);
  const walk = [];
  let at = full;
  while (true) {
    walk.push(at);
    if (at === stop || at === path.dirname(at)) break;
    at = path.dirname(at);
  }
  for (const item of walk.reverse()) {
    let stat;
    try { stat = fs.lstatSync(item); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Transfer refuses symlink or junction: ' + item);
  }
  return fs.existsSync(full) ? fs.lstatSync(full) : null;
}

function inside(root, sub) {
  const relative = path.relative(path.resolve(root), path.resolve(sub));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
function relativeEntry(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') ||
      value.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error('Invalid transfer entry path.');
  }
  return value;
}
function entryPath(root, relative) {
  const file = resolveWorkspaceRelativePath(root, relative.replaceAll('/', path.sep));
  if (!inside(root, file)) throw new Error('Transfer entry escapes target.');
  return file;
}
function fingerprint(stat) {
  return { dev: stat.dev, ino: stat.ino };
}
function sameIdentity(stat, id) {
  return stat && stat.dev === id.dev && stat.ino === id.ino;
}
function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, n));
    }
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
async function hashFileAsync(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export class WorkerTransferService {
  constructor({ workspaceRegistry, stateDir = null }) {
    this.workspaceRegistry = workspaceRegistry;
    this.sessions = new Map();
    this.stateDir = stateDir;
    if (stateDir) {
      fs.mkdirSync(stateDir, { recursive: true });
      for (const file of fs.readdirSync(stateDir).filter(name => name.endsWith('.json'))) {
        const journal = path.join(stateDir, file);
        try {
          const record = JSON.parse(fs.readFileSync(journal, 'utf8'));
          if (record.status === 'completed') {
            fs.unlinkSync(journal);
          } else if (record.status === 'active') {
            const residue = this.#safeCleanup(record);
            if (residue.length) {
              fs.writeFileSync(journal, JSON.stringify({ ...record, status: 'residue', residue }) + '\n');
            } else fs.unlinkSync(journal);
          }
        } catch {
          // Unknown or unverifiable objects are never deleted on startup.
        }
      }
    }
  }
  #journalPath(id) {
    if (!this.stateDir) return null;
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('Invalid transfer identifier.');
    return path.join(this.stateDir, id + '.json');
  }
  #snapshot(record, status = 'active') {
    return {
      status, destination: record.destination, dirs: record.dirs,
      files: record.files.map(item => item && {
        path: item.path, id: item.id, offset: item.offset,
        sha256: item.hash.copy().digest('hex'),
      }),
    };
  }
  #persist(id, record, status = 'active') {
    const file = this.#journalPath(id);
    if (!file) return;
    const temp = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(this.#snapshot(record, status)) + '\n', { flag: 'wx' });
      fs.renameSync(temp, file);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
  #safeCleanup(record) {
    const residue = [];
    for (const item of [...record.files].reverse()) {
      if (!item) continue;
      try {
        const stat = guardedStat(item.path);
        const expected = item.sha256 || item.hash?.copy().digest('hex');
        if (!sameIdentity(stat, item.id) || !stat.isFile() || stat.size !== item.offset ||
            !expected || hashFile(item.path) !== expected) {
          residue.push(item.path); continue;
        }
        fs.unlinkSync(item.path);
      } catch { residue.push(item.path); }
    }
    for (const dir of [...record.dirs].reverse()) {
      try {
        const stat = guardedStat(dir.path);
        if (sameIdentity(stat, dir.id) && stat.isDirectory()) fs.rmdirSync(dir.path);
        else if (stat) residue.push(dir.path);
      } catch { residue.push(dir.path); }
    }
    return residue;
  }
  environment(args) {
    if (!this.workspaceRegistry) throw new Error('Transfer requires a workspace registry.');
    return this.workspaceRegistry.environmentFor(args.workspace_id, args.expected_workspace_root);
  }
  source(args) {
    const env = this.environment(args);
    const file = path.resolve(env.cwd, args.source_path);
    const root = fs.realpathSync.native(env.cwd);
    if (!inside(root, file)) {
      // Source reads may be absolute outside the selected workspace.
      guardedStat(file);
    } else {
      guardedStat(file, root);
    }
    return file;
  }
  inspect(args) {
    const file = this.source(args);
    const rootStat = guardedStat(file);
    if (!rootStat || (!rootStat.isFile() && !rootStat.isDirectory())) {
      throw new Error('Transfer source must be a regular file or directory.');
    }
    const entries = [];
    const seen = new Set();
    const visit = (location, relative) => {
      const stat = guardedStat(location);
      if (!stat || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsupported transfer source entry: ' + location);
      const identity = stat.dev + ':' + stat.ino;
      if (stat.isDirectory()) {
        if (seen.has(identity)) throw new Error('Transfer source directory loop.');
        seen.add(identity);
      }
      entries.push({ path: relative, type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.isFile() ? stat.size : 0, mtime_ms: stat.mtimeMs });
      if (entries.length > MAX_ENTRIES) throw new Error('Transfer entry count limit exceeded.');
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(location)) {
          visit(path.join(location, name), relative ? relative + '/' + name : name);
        }
      }
    };
    if (rootStat.isFile()) {
      entries.push({ path: '', type: 'file', size: rootStat.size, mtime_ms: rootStat.mtimeMs });
    } else {
      visit(file, '');
    }
    if (Buffer.byteLength(JSON.stringify(entries), 'utf8') > 8 * 1024 * 1024) {
      throw new Error('Transfer manifest exceeds 8 MiB; split the directory.');
    }
    return { kind: rootStat.isFile() ? 'file' : 'dir', entries, source_path: file };
  }
  read(args) {
    const file = this.source(args);
    const target = args.relative ? path.join(file, ...relativeEntry(args.relative).split('/')) : file;
    if (!inside(file, target)) throw new Error('Source entry escapes selected transfer.');
    const stat = guardedStat(target);
    if (!stat?.isFile() || stat.size !== args.size || stat.mtimeMs !== args.mtime_ms) {
      throw new Error('Transfer source changed during copy.');
    }
    const length = args.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > TRANSFER_CHUNK_BYTES ||
        !Number.isSafeInteger(args.offset) || args.offset < 0 ||
        args.offset + length > stat.size) throw new Error('Invalid transfer read range.');
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(target, 'r');
    try {
      const opened = fs.fstatSync(fd);
      if (!sameIdentity(opened, fingerprint(stat))) throw new Error('Transfer source changed.');
      let at = 0;
      while (at < length) {
        const n = fs.readSync(fd, buffer, at, length - at, args.offset + at);
        if (!n) throw new Error('Transfer source truncated.');
        at += n;
      }
      return { data: buffer.toString('base64'), byte_length: length };
    } finally { fs.closeSync(fd); }
  }
  async digest(args) {
    const file = this.source(args);
    const target = args.relative ? path.join(file, ...relativeEntry(args.relative).split('/')) : file;
    if (!inside(file, target)) throw new Error('Source entry escapes selected transfer.');
    const before = guardedStat(target);
    if (!before?.isFile() || before.size !== args.size || before.mtimeMs !== args.mtime_ms) {
      throw new Error('Transfer source changed.');
    }
    const sha256 = await hashFileAsync(target);
    const after = guardedStat(target);
    if (!after || !sameIdentity(after, fingerprint(before)) ||
        after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Transfer source changed while hashing.');
    }
    return { sha256 };
  }
  reserve(args) {
    const env = this.environment(args);
    if (env.permissionProfile === 'read-only') {
      throw new Error('Transfer target workspace is read-only.');
    }
    if (!args.transfer_id || this.sessions.has(args.transfer_id)) throw new Error('Duplicate transfer id.');
    const destination = resolveWorkspaceRelativePath(env.cwd, args.target_path, 'target_path');
    if (path.resolve(destination) === path.resolve(env.cwd)) throw new Error('Target cannot be workspace root.');
    if (guardedStat(destination, env.cwd)) throw new Error('Transfer destination already exists.');
    if (!Array.isArray(args.entries) || args.entries.length === 0 || args.entries.length > MAX_ENTRIES) {
      throw new Error('Invalid transfer manifest.');
    }
    const record = { destination, dirs: [], files: [], done: false };
    const manifest = args.entries;
    if (manifest[0]?.path !== '' || manifest[0]?.type !== args.kind) throw new Error('Invalid transfer root entry.');
    const names = new Set();
    const normalized = manifest.map((item, index) => {
      const rel = item.path === '' ? '' : relativeEntry(item.path);
      const key = rel.toLowerCase();
      if (names.has(key)) throw new Error('Duplicate transfer entry.');
      names.add(key);
      if (item.type !== 'dir' && item.type !== 'file') throw new Error('Invalid transfer entry type.');
      if (item.type === 'file' && (!Number.isSafeInteger(item.size) || item.size < 0)) throw new Error('Invalid transfer file length.');
      return { ...item, index, rel };
    });
    const existingParents = [];
    let ancestor = path.dirname(destination);
    while (inside(env.cwd, ancestor) && ancestor !== env.cwd && !fs.existsSync(ancestor)) {
      existingParents.unshift(ancestor);
      ancestor = path.dirname(ancestor);
    }
    if (!guardedStat(ancestor, env.cwd)?.isDirectory()) throw new Error('Invalid transfer parent directory.');
    this.sessions.set(args.transfer_id, record);
    try {
      this.#persist(args.transfer_id, record);
      for (const parent of existingParents) {
        fs.mkdirSync(parent);
        record.dirs.push({ path: parent, id: fingerprint(fs.lstatSync(parent)) });
        this.#persist(args.transfer_id, record);
      }
      for (const entry of normalized) {
        const location = entry.rel ? entryPath(destination, entry.rel) : destination;
        if (!inside(destination, location)) throw new Error('Invalid destination entry.');
        const parent = path.dirname(location);
        if (!guardedStat(parent, env.cwd)?.isDirectory()) throw new Error('Manifest entries must be parent-first.');
        if (entry.type === 'dir') {
          fs.mkdirSync(location);
          record.dirs.push({ path: location, id: fingerprint(fs.lstatSync(location)) });
          this.#persist(args.transfer_id, record);
        } else {
          const fd = fs.openSync(location, 'wx+');
          const id = fingerprint(fs.fstatSync(fd));
          fs.closeSync(fd);
          const item = { path: location, id, size: entry.size, offset: 0,
            hash: crypto.createHash('sha256'), finished: false };
          record.files[entry.index] = item;
          this.#persist(args.transfer_id, record);
        }
      }
      return { reserved: true, file_count: record.files.filter(Boolean).length };
    } catch (error) {
      const cleanup = this.abort({ transfer_id: args.transfer_id });
      if (!cleanup.cleaned) {
        error.message += ' (transfer residue: ' + cleanup.residue.join(', ') + ')';
      }
      throw error;
    }
  }
  write(args) {
    const record = this.sessions.get(args.transfer_id);
    const item = record?.files[args.index];
    if (!item || item.finished) throw new Error('Unknown or finished transfer file.');
    const data = Buffer.from(args.data, 'base64');
    if (data.length === 0 || data.length > TRANSFER_CHUNK_BYTES ||
        data.toString('base64') !== args.data) throw new Error('Invalid transfer chunk.');
    if (!Number.isSafeInteger(args.offset) || args.offset < 0 ||
        args.offset + data.length > item.size) throw new Error('Invalid transfer write offset.');
    const stat = guardedStat(item.path);
    if (!sameIdentity(stat, item.id) || !stat.isFile()) throw new Error('Destination changed during transfer.');
    const fd = fs.openSync(item.path, 'r+');
    try {
      if (!sameIdentity(fs.fstatSync(fd), item.id)) throw new Error('Destination changed during transfer.');
      if (args.offset < item.offset && args.offset + data.length <= item.offset) {
        const existing = Buffer.alloc(data.length);
        fs.readSync(fd, existing, 0, data.length, args.offset);
        if (!existing.equals(data)) throw new Error('Conflicting retry chunk.');
        return { offset: item.offset };
      }
      if (args.offset !== item.offset) throw new Error('Out-of-order transfer chunk.');
      let at = 0;
      while (at < data.length) at += fs.writeSync(fd, data, at, data.length - at, item.offset + at);
      item.hash.update(data);
      item.offset += data.length;
      this.#persist(args.transfer_id, record);
      return { offset: item.offset };
    } finally { fs.closeSync(fd); }
  }
  async finish(args) {
    const record = this.sessions.get(args.transfer_id);
    const item = record?.files[args.index];
    if (!item) throw new Error('Unknown transfer file.');
    if (item.finished) return { sha256: item.digest };
    if (item.offset !== item.size) throw new Error('Transfer file incomplete.');
    const stat = guardedStat(item.path);
    if (!sameIdentity(stat, item.id) || stat.size !== item.size) throw new Error('Destination file changed.');
    const digest = item.hash.copy().digest('hex');
    if (digest !== args.sha256 || await hashFileAsync(item.path) !== digest) throw new Error('Transfer SHA-256 mismatch.');
    item.digest = digest;
    item.finished = true;
    return { sha256: digest };
  }
  commit(args) {
    const record = this.sessions.get(args.transfer_id);
    if (!record || record.files.some(item => item && !item.finished)) throw new Error('Transfer is incomplete.');
    this.#persist(args.transfer_id, record, 'completed');
    this.sessions.delete(args.transfer_id);
    const journal = this.#journalPath(args.transfer_id);
    if (journal) fs.rmSync(journal, { force: true });
    return { completed: true, destination: record.destination };
  }
  abort(args) {
    const record = this.sessions.get(args.transfer_id);
    if (!record) return { cleaned: true, residue: [] };
    this.sessions.delete(args.transfer_id);
    const residue = this.#safeCleanup(record);
    const journal = this.#journalPath(args.transfer_id);
    if (journal) {
      if (residue.length) {
        this.#persist(args.transfer_id, record, 'residue');
      } else fs.rmSync(journal, { force: true });
    }
    return { cleaned: residue.length === 0, residue };
  }
}
