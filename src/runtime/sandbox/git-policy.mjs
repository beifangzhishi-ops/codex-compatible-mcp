import {
  canonicalExecutableToken,
  parseShellCommand,
} from './shell-policy-parser.mjs';

const REMOTE_GIT_SUBCOMMANDS = new Set([
  'clone',
  'fetch',
  'pull',
  'push',
  'ls-remote',
]);

export function isTrustedRemoteGitSegment(tokens, { platform = 'windows' } = {}) {
  if (platform !== 'windows') return false;
  if (!Array.isArray(tokens) || tokens.length < 2) return false;
  if (canonicalExecutableToken(tokens[0], { platform }) !== 'git') return false;
  const subcommand = String(tokens[1] || '').toLowerCase();
  if (subcommand.startsWith('-')) return false;
  return REMOTE_GIT_SUBCOMMANDS.has(subcommand);
}

export function isTrustedRemoteGitCommand(
  command,
  { shell = 'powershell', platform = 'windows' } = {},
) {
  if (platform !== 'windows') return false;
  const parsed = parseShellCommand(command, { shell });
  return Boolean(parsed?.segments.length) &&
    parsed.segments.every((segment) =>
      isTrustedRemoteGitSegment(segment.tokens, { platform }));
}

export function resolveGitAwarePermissionProfile(
  baseProfile,
  command,
  { shell = 'powershell', platform = 'windows' } = {},
) {
  if (baseProfile === 'workspace-write' &&
      isTrustedRemoteGitCommand(command, { shell, platform })) {
    return 'trusted-git';
  }
  return baseProfile;
}

export { REMOTE_GIT_SUBCOMMANDS };
