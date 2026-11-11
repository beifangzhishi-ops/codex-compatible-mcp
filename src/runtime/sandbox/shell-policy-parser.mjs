import { parseCodexPowerShellScript } from './codex-powershell-parser.mjs';

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

// Codex's user-approved prefix_rule uses PrefixPattern::tokens_equal with
// canonical_matching=false: every token must match exactly. OS-specific
// executable-name folding is not part of a saved prefix rule.
export function tokenPrefixMatches(prefix, tokens) {
  const normalized = validatePrefixTokens(prefix);
  if (!normalized || !Array.isArray(tokens) || tokens.length < normalized.length) {
    return false;
  }
  for (let i = 0; i < normalized.length; i += 1) {
    const expected = normalized[i];
    const actual = tokens[i];
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
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') return true;
    if (ch === '$' && next === '(') return true;
    if (ch === '#') return true;
  } else if (ch === '(' || ch === ')') {
    return true;
  }
  return false;
}

// PowerShell uses & for both quoted paths and bare executable names. These
// are static invocation targets; expressions, variables and concatenations
// are not. This is a CCM-approved extension to the upstream lowering subset.
const literalCall = /^&\s+(?:'(?:[^']|'')+'|"[^"$`]+"|[A-Za-z_.][A-Za-z0-9_.:\\/-]*)(?=\s|$)/;

// An environment assignment is a policy-neutral prefix only when its entire
// value is a non-expanding literal. Do not evaluate environment variables or
// infer the target of a dynamic invocation.
const literalEnvironmentAssignment =
  /^\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:'(?:[^']|'')*'|"[^"$`]*")$/i;

function parseLocalCommandSources(command, { shell = 'powershell' } = {}) {
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
    if (shellKind !== 'cmd' && ch === '&' && next !== '&') {
      if (command.slice(start, i).trim() ||
          !literalCall.test(command.slice(i))) return null;
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
    const isLiteralCall = shellKind !== 'cmd' && literalCall.test(segment.source);
    const source = isLiteralCall
      ? segment.source.slice(1).trimStart()
      : segment.source;
    const tokens = tokenizeSegment(source, shellKind);
    if (!tokens) return null;
    segments.push({ ...segment, tokens });
  }
  return { shell: shellKind, segments, operators };
}

// The pinned Codex parser deliberately leaves PowerShell assignments and &
// calls opaque. When it rejects the complete script, recognize only literal
// env statements between statements and static call targets, then ask the
// unchanged Codex parser to validate every remaining ordinary command.
// This does not rewrite or execute the submitted script.
function parseLiteralPowerShellWrappers(command, shellKind) {
  const local = parseLocalCommandSources(command, { shell: shellKind });
  if (!local) return null;
  const segments = [];
  let recognizedWrapper = false;
  for (let i = 0; i < local.segments.length; i += 1) {
    const segment = local.segments[i];
    if (literalEnvironmentAssignment.test(segment.source)) {
      // A prefix must lead to a command. Assignments cannot be pipeline or
      // conditional-chain operands, nor can a trailing assignment inherit
      // the preceding command's Allow decision.
      if (i === local.segments.length - 1 ||
          (i > 0 && ![';', 'newline'].includes(local.operators[i - 1])) ||
          ![';', 'newline'].includes(local.operators[i])) return null;
      recognizedWrapper = true;
      continue;
    }
    const isCall = literalCall.test(segment.source);
    if (isCall) {
      recognizedWrapper = true;
    } else {
      const lowered = parseCodexPowerShellScript(segment.source);
      if (!lowered || lowered.length !== 1 ||
          lowered[0].length !== segment.tokens.length ||
          !lowered[0].every((token, index) => token === segment.tokens[index])) {
        return null;
      }
    }
    segments.push({ tokens: segment.tokens });
  }
  if (!recognizedWrapper || !segments.length) return null;
  return { shell: shellKind, segments, operators: [] };
}

export function parseShellCommand(command, { shell = 'powershell' } = {}) {
  const shellKind = canonicalShell(shell) || 'powershell';
  if (shellKind === 'cmd') {
    const local = parseLocalCommandSources(command, { shell });
    return local ? {
      shell: shellKind,
      segments: local.segments.map(({ tokens }) => ({ tokens })),
      operators: local.operators,
    } : null;
  }
  if (shellKind !== 'powershell' && shellKind !== 'pwsh') return null;

  // The Codex native parser is the sole authority for lowering PowerShell
  // syntax into commands that may receive an Allow decision.
  const lowered = parseCodexPowerShellScript(command);
  if (!lowered) return parseLiteralPowerShellWrappers(command, shellKind);

  // Preserve local statement boundaries only when their tokens agree exactly
  // with the upstream lowering. The source text is never rewritten.
  const local = parseLocalCommandSources(command, { shell });
  const boundariesMatch = Boolean(local &&
    local.segments.length === lowered.length &&
    local.segments.every((segment, i) =>
      segment.tokens.length === lowered[i].length &&
      segment.tokens.every((word, j) => word === lowered[i][j])));
  return {
    shell: shellKind,
    segments: lowered.map((tokens) => ({ tokens })),
    operators: boundariesMatch ? local.operators : [],
  };
}

