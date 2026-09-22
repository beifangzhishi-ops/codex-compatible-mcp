import fs from 'node:fs/promises';
import path from 'node:path';

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const ENVIRONMENT = '*** Environment ID: ';
const EOF = '*** End of File';

function patchError(message, line = null) {
  const suffix = line == null ? '' : ' at line ' + line;
  return new Error('apply_patch verification failed' + suffix + ': ' + message);
}

function marker(line) {
  return String(line ?? '').trim();
}

function isFileMarker(line) {
  const value = marker(line);
  return value === END ||
    value.startsWith(ADD) ||
    value.startsWith(DELETE) ||
    value.startsWith(UPDATE);
}

export function parsePatch(patchText) {
  if (typeof patchText !== 'string' || !patchText.trim()) {
    throw patchError('patch must be a non-empty string');
  }

  const normalized = patchText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  while (lines.length > 1 && lines.at(-1) === '') lines.pop();

  if (marker(lines[0]) !== BEGIN) {
    throw patchError("the first line must be '" + BEGIN + "'");
  }
  if (marker(lines.at(-1)) !== END) {
    throw patchError("the last line must be '" + END + "'");
  }

  let index = 1;
  let environmentId = null;
  const hunks = [];

  if (marker(lines[index]).startsWith(ENVIRONMENT)) {
    environmentId = marker(lines[index]).slice(ENVIRONMENT.length).trim();
    if (!environmentId) throw patchError('environment_id cannot be empty', index + 1);
    index += 1;
  }
  while (index < lines.length - 1) {
    const control = marker(lines[index]);

    if (control.startsWith(ADD)) {
      const filePath = control.slice(ADD.length).trim();
      if (!filePath) throw patchError('Add File path cannot be empty', index + 1);
      index += 1;
      const added = [];
      while (index < lines.length - 1 && !isFileMarker(lines[index])) {
        const line = lines[index];
        if (!line.startsWith('+')) {
          throw patchError('Add File lines must start with +', index + 1);
        }
        added.push(line.slice(1));
        index += 1;
      }
      if (added.length === 0) {
        throw patchError('Add File hunk must contain at least one + line');
      }
      hunks.push({ type: 'add', path: filePath, content: added.join('\n') + '\n' });
      continue;
    }

    if (control.startsWith(DELETE)) {
      const filePath = control.slice(DELETE.length).trim();
      if (!filePath) throw patchError('Delete File path cannot be empty', index + 1);
      hunks.push({ type: 'delete', path: filePath });
      index += 1;
      continue;
    }
    if (control.startsWith(UPDATE)) {
      const filePath = control.slice(UPDATE.length).trim();
      if (!filePath) throw patchError('Update File path cannot be empty', index + 1);
      index += 1;

      let movePath = null;
      if (marker(lines[index]).startsWith(MOVE)) {
        movePath = marker(lines[index]).slice(MOVE.length).trim();
        if (!movePath) throw patchError('Move to path cannot be empty', index + 1);
        index += 1;
      }

      const chunks = [];
      let current = null;
      const flush = () => {
        if (!current) return;
        if (current.oldLines.length === 0 &&
            current.newLines.length === 0 &&
            !current.isEndOfFile) return;
        chunks.push(current);
        current = null;
      };

      while (index < lines.length - 1 && !isFileMarker(lines[index])) {
        const line = lines[index];
        const controlLine = marker(line);

        if (controlLine === '@@' || controlLine.startsWith('@@ ')) {
          flush();
          current = {
            context: controlLine === '@@' ? null : controlLine.slice(3),
            oldLines: [],
            newLines: [],
            contextPairs: [],
            isEndOfFile: false,
          };
          index += 1;
          continue;
        }
        if (!current) {
          current = {
            context: null,
            oldLines: [],
            newLines: [],
            contextPairs: [],
            isEndOfFile: false,
          };
        }

        if (controlLine === EOF) {
          current.isEndOfFile = true;
          index += 1;
          continue;
        }

        if (current.isEndOfFile && line === '') {
          index += 1;
          continue;
        }

        if (line.startsWith(' ')) {
          const value = line.slice(1);
          current.contextPairs.push([
            current.oldLines.length,
            current.newLines.length,
          ]);
          current.oldLines.push(value);
          current.newLines.push(value);
        } else if (line.startsWith('-')) {
          current.oldLines.push(line.slice(1));
        } else if (line.startsWith('+')) {
          current.newLines.push(line.slice(1));
        } else if (line === '') {
          throw patchError('blank diff lines must use a leading space', index + 1);
        } else {
          throw patchError('invalid Update File line', index + 1);
        }
        index += 1;
      }

      flush();
      if (chunks.length === 0) {
        throw patchError("Update File hunk for path '" + filePath + "' is empty");
      }
      hunks.push({ type: 'update', path: filePath, movePath, chunks });
      continue;
    }
    throw patchError('unknown patch marker: ' + control, index + 1);
  }

  return { environmentId, hunks };
}

function splitText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const finalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (finalNewline) lines.pop();
  return { lines, eol, finalNewline };
}

function joinText(lines, eol, finalNewline) {
  const body = lines.join(eol);
  return finalNewline ? body + eol : body;
}

function rstrip(value) {
  return value.replace(/[ \t]+$/u, '');
}

function normalizePunctuation(value) {
  return value.trim()
    .replace(/[‐‑‒–—―−]/gu, '-')
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/gu, ' ');
}
function trySequence(lines, pattern, start, compare) {
  if (pattern.length === 0) return { index: start, mode: 'empty' };
  const last = lines.length - pattern.length;
  for (let index = start; index <= last; index += 1) {
    let matches = true;
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (!compare(lines[index + offset], pattern[offset])) {
        matches = false;
        break;
      }
    }
    if (matches) return { index, mode: compare.mode };
  }
  return null;
}

function findSequence(lines, pattern, start, eof = false) {
  if (pattern.length === 0) {
    return {
      index: eof ? lines.length : Math.min(start, lines.length),
      mode: 'empty',
    };
  }
  if (pattern.length > lines.length) return null;

  const starts = [];
  if (eof) starts.push(Math.max(start, lines.length - pattern.length));
  starts.push(start);

  const comparisons = [
    Object.assign((a, b) => a === b, { mode: 'exact' }),
    Object.assign((a, b) => rstrip(a) === rstrip(b), { mode: 'rstrip' }),
    Object.assign((a, b) => a.trim() === b.trim(), { mode: 'trim' }),
    Object.assign(
      (a, b) => normalizePunctuation(a) === normalizePunctuation(b),
      { mode: 'normalized' },
    ),
  ];

  for (const searchStart of [...new Set(starts)]) {
    for (const compare of comparisons) {
      const match = trySequence(lines, pattern, searchStart, compare);
      if (match) return match;
    }
  }
  return null;
}
function applyUpdateText(text, hunk, filePath) {
  const split = splitText(text);
  const lines = [...split.lines];
  let cursor = 0;

  for (const chunk of hunk.chunks) {
    if (chunk.context != null) {
      const contextMatch = findSequence(lines, [chunk.context], cursor, false);
      if (!contextMatch) {
        throw patchError(
          "context '" + chunk.context + "' was not found in " + filePath,
        );
      }
      cursor = contextMatch.index + 1;
    }

    const match = findSequence(
      lines,
      chunk.oldLines,
      cursor,
      chunk.isEndOfFile,
    );
    if (!match) {
      throw patchError(
        'target lines were not found in ' + filePath +
        (chunk.context ? " after context '" + chunk.context + "'" : ''),
      );
    }

    const replacement = [...chunk.newLines];
    for (const [oldIndex, newIndex] of chunk.contextPairs) {
      if (newIndex < replacement.length && oldIndex < chunk.oldLines.length) {
        replacement[newIndex] = lines[match.index + oldIndex];
      }
    }

    lines.splice(match.index, chunk.oldLines.length, ...replacement);
    cursor = match.index + replacement.length;
  }

  return joinText(lines, split.eol, split.finalNewline);
}

export function applySingleFilePatchToText({
  patch: patchText,
  currentText = null,
  targetPath = 'plan.md',
  mode,
}) {
  if (mode !== 'add' && mode !== 'update') {
    throw patchError("single-file patch mode must be 'add' or 'update'");
  }
  const parsed = parsePatch(patchText);
  if (parsed.environmentId) {
    throw patchError('single-file text patches do not accept Environment ID');
  }
  if (parsed.hunks.length !== 1) {
    throw patchError('single-file text patches require exactly one file hunk');
  }
  const hunk = parsed.hunks[0];
  if (hunk.path !== targetPath) {
    throw patchError("patch target must be '" + targetPath + "'");
  }
  if (hunk.type !== mode) {
    throw patchError(
      "patch for '" + targetPath + "' must use " +
      (mode === 'add' ? 'Add File' : 'Update File'),
    );
  }
  if (hunk.movePath) {
    throw patchError('single-file text patches do not accept Move to');
  }
  if (mode === 'add') return hunk.content;
  if (typeof currentText !== 'string') {
    throw patchError('Update File requires existing text content');
  }
  return applyUpdateText(currentText, hunk, targetPath);
}

function resolveWorkdir(environment, requested) {
  if (!requested) return environment.cwd;
  return path.isAbsolute(requested)
    ? path.normalize(requested)
    : path.resolve(environment.cwd, requested);
}

function resolveTarget(workdir, value) {
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(workdir, value);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
     relative !== '..' &&
     !path.isAbsolute(relative));
}
async function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw patchError('unable to resolve an existing ancestor for: ' + target);
    }
    current = parent;
  }
}

async function assertWritableTargets(environment, targets) {
  const profile = environment.permissionProfile || 'workspace-write';
  if (profile === 'read-only') {
    throw patchError('environment is read-only');
  }
  if (profile === 'full-access') return;
  if (profile !== 'workspace-write') {
    throw patchError('unsupported permission profile: ' + profile);
  }

  const roots = await Promise.all(
    (environment.workspaceRoots || []).map(async (root) => {
      const lexical = path.resolve(root);
      const real = await fs.realpath(lexical).catch((error) => {
        throw patchError(
          'workspace root is not accessible: ' + lexical + ': ' +
          String(error?.message || error),
        );
      });
      return { lexical, real };
    }),
  );

  for (const target of targets) {
    const absolute = path.resolve(target);
    const lexicalRoot = roots.find(({ lexical }) => isWithin(lexical, absolute));
    if (!lexicalRoot) {
      throw patchError(
        'workspace-write forbids modifying path outside workspace roots: ' + absolute,
      );
    }

    const ancestor = await nearestExistingAncestor(absolute);
    const realAncestor = await fs.realpath(ancestor);
    if (!isWithin(lexicalRoot.real, realAncestor)) {
      throw patchError(
        'workspace-write forbids symlink/junction escape outside workspace roots: ' +
        absolute,
      );
    }
  }
}

async function loadState(states, absolutePath) {
  if (states.has(absolutePath)) return states.get(absolutePath);

  let exists = false;
  let content = '';
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      throw patchError('patch target is not a file: ' + absolutePath);
    }
    const bytes = await fs.readFile(absolutePath);
    if (bytes.includes(0)) {
      throw patchError('patch target appears to be binary: ' + absolutePath);
    }
    content = bytes.toString('utf8');
    exists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const state = {
    path: absolutePath,
    initialExists: exists,
    exists,
    initialContent: content,
    content,
    dirty: false,
  };
  states.set(absolutePath, state);
  return state;
}

function summaryLine(type, source, destination = null) {
  if (type === 'add') return 'A ' + source;
  if (type === 'delete') return 'D ' + source;
  if (destination) return 'M ' + source + ' -> ' + destination;
  return 'M ' + source;
}
export async function applyPatchToEnvironment({
  environment,
  patch: patchText,
  workdir: requestedWorkdir,
  environmentId,
}) {
  if (!environment) throw patchError('environment is required');
  const parsed = parsePatch(patchText);

  if (parsed.environmentId &&
      environmentId &&
      parsed.environmentId !== environmentId) {
    throw patchError(
      'patch environment_id ' + parsed.environmentId +
      ' does not match selected environment ' + environmentId,
    );
  }
  if (parsed.environmentId && parsed.environmentId !== environment.id) {
    throw patchError(
      'patch targets environment ' + parsed.environmentId +
      ' but Worker environment is ' + environment.id,
    );
  }

  const workdir = resolveWorkdir(environment, requestedWorkdir);
  const resolved = parsed.hunks.map((hunk) => ({
    hunk,
    source: resolveTarget(workdir, hunk.path),
    destination: hunk.type === 'update' && hunk.movePath
      ? resolveTarget(workdir, hunk.movePath)
      : null,
  }));

  await assertWritableTargets(
    environment,
    resolved.flatMap(({ source, destination }) =>
      destination ? [source, destination] : [source]),
  );

  const states = new Map();
  const changes = [];
  for (const item of resolved) {
    const { hunk, source } = item;
    const sourceState = await loadState(states, source);

    if (hunk.type === 'add') {
      if (sourceState.exists) {
        throw patchError('Add File target already exists: ' + hunk.path);
      }
      sourceState.exists = true;
      sourceState.content = hunk.content;
      sourceState.dirty = true;
      changes.push({
        type: 'add',
        path: source,
        summary: summaryLine('add', hunk.path),
      });
      continue;
    }

    if (hunk.type === 'delete') {
      if (!sourceState.exists) {
        throw patchError('Delete File target does not exist: ' + hunk.path);
      }
      sourceState.exists = false;
      sourceState.dirty = true;
      changes.push({
        type: 'delete',
        path: source,
        summary: summaryLine('delete', hunk.path),
      });
      continue;
    }

    if (!sourceState.exists) {
      throw patchError('Update File target does not exist: ' + hunk.path);
    }

    const updated = applyUpdateText(sourceState.content, hunk, hunk.path);
    const destination = item.destination;
    if (!destination || destination === source) {
      sourceState.content = updated;
      sourceState.dirty = true;
      changes.push({
        type: 'update',
        path: source,
        summary: summaryLine('update', hunk.path),
      });
      continue;
    }
    const destinationState = await loadState(states, destination);
    if (destinationState.exists) {
      throw patchError('Move destination already exists: ' + hunk.movePath);
    }

    destinationState.exists = true;
    destinationState.content = updated;
    destinationState.dirty = true;
    sourceState.exists = false;
    sourceState.dirty = true;

    changes.push({
      type: 'move',
      path: source,
      destination,
      summary: summaryLine('update', hunk.path, hunk.movePath),
    });
  }

  // All parsing, matching, permission checks, and destination checks have
  // completed before the first filesystem mutation below.
  for (const state of states.values()) {
    if (!state.dirty || !state.exists) continue;
    await fs.mkdir(path.dirname(state.path), { recursive: true });
    await fs.writeFile(state.path, state.content, 'utf8');
  }

  for (const state of states.values()) {
    if (!state.dirty || state.exists || !state.initialExists) continue;
    await fs.unlink(state.path);
  }

  return {
    workdir,
    changes,
    output: changes.length === 0
      ? 'Done!'
      : 'Done!\n' + changes.map((change) => change.summary).join('\n'),
  };
}
