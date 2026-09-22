const REMOTE_GIT_SUBCOMMANDS = new Set([
  'clone',
  'fetch',
  'pull',
  'push',
  'ls-remote',
  'remote',
  'submodule',
  'lfs',
]);

function splitShellSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '`' && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|') {
      if (next === '|') {
        segments.push(current.trim());
        current = '';
        i += 1;
        continue;
      }
      return null;
    }
    if (ch === '&' && next === '&') {
      segments.push(current.trim());
      current = '';
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '\r') {
      if (ch === '\r' && next === '\n') i += 1;
      segments.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (quote || escaped) return null;
  segments.push(current.trim());
  return segments.filter(Boolean);
}

function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const ch of segment) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '`' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
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
  return tokens;
}

function gitSubcommand(tokens) {
  if (!tokens || tokens.length < 2) return null;
  const executable = tokens[0].toLowerCase();
  if (executable !== 'git' && executable !== 'git.exe') return null;

  const optionsWithValue = new Set([
    '-c',
    '-C',
    '--config-env',
    '--exec-path',
    '--git-dir',
    '--namespace',
    '--super-prefix',
    '--work-tree',
  ]);
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (optionsWithValue.has(token)) {
      i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token.toLowerCase();
  }
  return null;
}

export function isTrustedRemoteGitCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const segments = splitShellSegments(command);
  if (!segments?.length) return false;

  let hasRemoteOperation = false;
  for (const segment of segments) {
    const subcommand = gitSubcommand(tokenize(segment));
    if (!subcommand) return false;
    if (REMOTE_GIT_SUBCOMMANDS.has(subcommand)) hasRemoteOperation = true;
  }
  return hasRemoteOperation;
}

export function resolveGitAwarePermissionProfile(baseProfile, command) {
  if (baseProfile === 'workspace-write' && isTrustedRemoteGitCommand(command)) {
    return 'trusted-git';
  }
  return baseProfile;
}

export { REMOTE_GIT_SUBCOMMANDS };
