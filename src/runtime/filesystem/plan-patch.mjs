const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
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
  const hunks = [];
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

  return { hunks };
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
