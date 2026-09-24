function normalizeNullable(value) {
  return value == null || value === '' ? null : String(value);
}

export function canonicalShell(value) {
  const normalized = normalizeNullable(value);
  if (!normalized) return null;
  const name = normalized
    .split(/[\\/]/)
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (name === 'powershell') return 'powershell';
  if (name === 'pwsh') return 'pwsh';
  if (name === 'cmd') return 'cmd';
  return normalized.toLowerCase();
}

export function effectiveShell(args = {}, environment = {}) {
  return canonicalShell(
    args.shell || environment.shell?.path || environment.shell?.type || null,
  );
}

export function normalizeWorkdir(value) {
  const normalized = normalizeNullable(value);
  if (!normalized || normalized === '.' || normalized === '.\\' || normalized === './') {
    return null;
  }
  return normalized;
}

function isBareExecutable(token) {
  return typeof token === 'string' &&
    token.length > 0 &&
    !/[\\/]/.test(token) &&
    !/^[A-Za-z]:/.test(token);
}

export function canonicalExecutableToken(token, { platform = 'windows' } = {}) {
  const value = String(token || '');
  if (platform !== 'windows') return value;
  const lower = value.toLowerCase();
  return isBareExecutable(value) ? lower.replace(/\.exe$/, '') : lower;
}

export function validatePrefixTokens(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  const tokens = [];
  for (const token of value) {
    if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
      return null;
    }
    tokens.push(token);
  }
  return tokens;
}

export function tokenPrefixMatches(prefix, tokens, { platform = 'windows' } = {}) {
  const normalized = validatePrefixTokens(prefix);
  if (!normalized || !Array.isArray(tokens) || tokens.length < normalized.length) {
    return false;
  }
  for (let i = 0; i < normalized.length; i += 1) {
    const expected = normalized[i];
    const actual = tokens[i];
    if (i === 0) {
      const expectedBare = isBareExecutable(expected);
      const actualBare = isBareExecutable(actual);
      if (expectedBare !== actualBare) return false;
      if (canonicalExecutableToken(expected, { platform }) !==
          canonicalExecutableToken(actual, { platform })) {
        return false;
      }
      continue;
    }
    if (expected !== actual) return false;
  }
  return true;
}

function tokenizeSegment(source, shellKind) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const escapeChar = shellKind === 'cmd' ? '^' : String.fromCharCode(96);

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    const escapeApplies = shellKind === 'cmd'
      ? quote === null
      : quote !== "'";
    if (ch === escapeChar && escapeApplies) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (shellKind !== 'cmd' && quote === '"' && ch === '$' && source[i + 1] === '(') {
        return null;
      }
      if (shellKind !== 'cmd' && quote === "'" && ch === "'" && next === "'") {
        current += "'";
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || (shellKind !== 'cmd' && ch === "'")) {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote || escaped) return null;
  if (current) tokens.push(current);
  return tokens.length ? tokens : null;
}

function unsupportedOutsideQuote(command, index, shellKind) {
  const ch = command[index];
  const next = command[index + 1];
  if (ch === '>' || ch === '<') return true;
  if (shellKind !== 'cmd') {
    if (ch === '&' && next !== '&') return true;
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') return true;
    if (ch === '$' && next === '(') return true;
    if (ch === '#') return true;
  } else if (ch === '(' || ch === ')') {
    return true;
  }
  return false;
}

export function parseShellCommand(command, { shell = 'powershell' } = {}) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const shellKind = canonicalShell(shell) || 'powershell';
  if (!['powershell', 'pwsh', 'cmd'].includes(shellKind)) return null;

  const rawSegments = [];
  const operators = [];
  let quote = null;
  let escaped = false;
  let start = 0;
  const escapeChar = shellKind === 'cmd' ? '^' : String.fromCharCode(96);

  const pushSegment = (end, operator) => {
    const raw = command.slice(start, end);
    const leading = raw.search(/\S/);
    if (leading < 0) return false;
    const trailing = raw.length - raw.trimEnd().length;
    rawSegments.push({
      source: raw.trim(),
      start: start + leading,
      end: end - trailing,
    });
    operators.push(operator);
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    const escapeApplies = shellKind === 'cmd'
      ? quote === null
      : quote !== "'";
    if (ch === escapeChar && escapeApplies) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (shellKind !== 'cmd' && quote === '"' && ch === '$' && next === '(') {
        return null;
      }
      if (shellKind !== 'cmd' && quote === "'" && ch === "'" && next === "'") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || (shellKind !== 'cmd' && ch === "'")) {
      quote = ch;
      continue;
    }
    if (unsupportedOutsideQuote(command, i, shellKind)) return null;

    let operator = null;
    let width = 1;
    if (ch === '&' && next === '&') {
      operator = '&&';
      width = 2;
    } else if (ch === '|' && next === '|') {
      operator = '||';
      width = 2;
    } else if (ch === '|') {
      operator = '|';
    } else if (ch === ';') {
      operator = ';';
    } else if (ch === '\r' || ch === '\n') {
      operator = 'newline';
      if (ch === '\r' && next === '\n') width = 2;
    } else if (shellKind === 'cmd' && ch === '&') {
      operator = '&';
    }
    if (!operator) continue;
    if (!pushSegment(i, operator)) return null;
    i += width - 1;
    start = i + 1;
  }

  if (quote || escaped) return null;
  const tail = command.slice(start);
  if (!tail.trim()) return null;
  rawSegments.push({
    source: tail.trim(),
    start: start + tail.search(/\S/),
    end: command.length - (tail.length - tail.trimEnd().length),
  });

  const segments = [];
  for (const segment of rawSegments) {
    const tokens = tokenizeSegment(segment.source, shellKind);
    if (!tokens) return null;
    segments.push({ ...segment, tokens });
  }
  return { shell: shellKind, segments, operators };
}

