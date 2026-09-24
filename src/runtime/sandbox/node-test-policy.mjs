import {
  canonicalExecutableToken,
  parseShellCommand,
} from './shell-policy-parser.mjs';

export function isTrustedNodeTestSegment(tokens, { platform = 'windows' } = {}) {
  if (platform !== 'windows') return false;
  if (!Array.isArray(tokens) || tokens.length < 2) return false;
  return canonicalExecutableToken(tokens[0], { platform }) === 'node' &&
    tokens[1] === '--test';
}

export function isTrustedNodeTestCommand(
  command,
  { shell = 'powershell', platform = 'windows' } = {},
) {
  const parsed = parseShellCommand(command, { shell });
  return Boolean(parsed?.segments.length) &&
    parsed.segments.every((segment) =>
      isTrustedNodeTestSegment(segment.tokens, { platform }));
}

