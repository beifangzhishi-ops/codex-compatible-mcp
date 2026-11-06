import fs from 'node:fs';
import { DEFAULT_CCM_CONFIG_FILE } from '../ccm-config.mjs';
import {
  canonicalExecutableToken,
  effectiveShell,
  parseShellCommand,
} from './shell-policy-parser.mjs';

export const DEFAULT_TRUSTED_COMMANDS_FILE = DEFAULT_CCM_CONFIG_FILE;

const SHELLS = new Set(['powershell', 'pwsh', 'cmd']);
const ARGUMENT_TYPES = new Set(['any', 'prefix', 'subcommand']);
const EXECUTION_TYPES = new Set(['original', 'pinned']);

function expectKeys(object, required, optional = []) {
  if (!object || Array.isArray(object) || typeof object !== 'object') {
    throw new Error('expected an object');
  }
  const keys = Object.keys(object);
  if (required.some((key) => !Object.hasOwn(object, key)) ||
      keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error('missing or unexpected fields: ' + keys.join(', '));
  }
}

function strings(value, name, { pattern = null } = {}) {
  if (!Array.isArray(value) || !value.length ||
      value.some((item) => typeof item !== 'string' || !item ||
        (pattern && !pattern.test(item))) ||
      new Set(value).size !== value.length) {
    throw new Error(name + ' must contain unique, nonempty strings');
  }
  return value;
}

// A plain executable name is matched only when typed without a directory.
// Pinned paths are checked separately and cannot be aliases for another rule.
const EXECUTABLE_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*(?:\.exe)?$/;
const WINDOWS_EXECUTABLE = /^[a-zA-Z]:\\(?:[^\\/:*?"'<>|\r\n]+\\)*[^\\/:*?"'<>|\r\n]+\.exe$/i;

export function validateTrustedCommands(config) {
  expectKeys(config, ['version', 'rules']);
  if (config.version !== 1 || !Array.isArray(config.rules)) {
    throw new Error('unsupported trusted-command configuration version');
  }
  const ids = new Set();
  return config.rules.map((rule) => {
    expectKeys(rule, [
      'id', 'platform', 'permission_profile', 'shells',
      'executables', 'arguments', 'execution',
    ]);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(rule.id) || ids.has(rule.id)) {
      throw new Error('invalid or duplicated trusted-command rule id');
    }
    ids.add(rule.id);
    if (rule.platform !== 'windows' || rule.permission_profile !== 'workspace-write') {
      throw new Error('unsupported trusted-command platform/profile: ' + rule.id);
    }
    strings(rule.shells, 'shells').forEach((shell) => {
      if (!SHELLS.has(shell)) throw new Error('unsupported shell: ' + shell);
    });
    strings(rule.executables, 'executables', { pattern: EXECUTABLE_NAME });
    expectKeys(rule.arguments, ['type'],
      rule.arguments.type === 'prefix' ? ['tokens'] :
      rule.arguments.type === 'subcommand' ? ['values'] : []);
    if (!ARGUMENT_TYPES.has(rule.arguments.type)) {
      throw new Error('unsupported argument matcher: ' + rule.id);
    }
    if (rule.arguments.type === 'prefix') {
      strings(rule.arguments.tokens, 'prefix tokens');
    }
    if (rule.arguments.type === 'subcommand') {
      strings(rule.arguments.values, 'subcommand values');
    }
    expectKeys(rule.execution, ['type'],
      rule.execution.type === 'pinned' ? ['path'] : []);
    if (!EXECUTION_TYPES.has(rule.execution.type)) {
      throw new Error('unsupported execution target: ' + rule.id);
    }
    if (rule.execution.type === 'pinned' &&
        (typeof rule.execution.path !== 'string' ||
         !WINDOWS_EXECUTABLE.test(rule.execution.path))) {
      throw new Error('invalid pinned executable path: ' + rule.id);
    }
    return rule;
  });
}

// Configuration is read on every new authorization decision, not at startup.
// An invalid file disables only the built-in trust class for that request.
export function loadTrustedCommands(file = DEFAULT_TRUSTED_COMMANDS_FILE) {
  try {
    return { rules: validateTrustedCommands(JSON.parse(fs.readFileSync(file, 'utf8')).trusted_commands) };
  } catch (error) {
    return { rules: [], error: 'Trusted-command configuration unavailable: ' +
      String(error?.message || error) };
  }
}

function matchingArguments(tokens, rule) {
  const args = tokens.slice(1);
  switch (rule.arguments.type) {
    case 'any': return true;
    case 'subcommand': return typeof args[0] === 'string' &&
      rule.arguments.values.some((value) => value.toLowerCase() === args[0].toLowerCase());
    case 'prefix': return rule.arguments.tokens.every((token, index) => args[index] === token);
    default: return false;
  }
}

// Return the exact syntactic program prefix and preserve the original arguments
// byte-for-byte. Never try to interpret a computed PowerShell call target.
function programPrefix(segment, shell) {
  const source = segment.source;
  const called = shell !== 'cmd' && /^&\s+/.exec(source);
  const offset = called ? called[0].length : 0;
  const remainder = source.slice(offset);
  let match;
  if (remainder[0] === '"' || remainder[0] === "'") {
    if (shell === 'cmd' && remainder[0] !== '"') return null;
    const mark = remainder[0];
    const end = remainder.indexOf(mark, 1);
    if (end < 1 || (remainder[end + 1] && !/\s/.test(remainder[end + 1]))) return null;
    match = remainder.slice(0, end + 1);
  } else {
    match = /^[^\s'"&|;<>]+/.exec(remainder)?.[0];
  }
  if (!match) return null;
  return { source: source.slice(0, offset + match.length),
    executable: remainder.slice(0, match.length).replace(/^['"]|['"]$/g, '') };
}

function matchSegment(segment, rule, shell) {
  if (!rule.shells.includes(shell)) return null;
  const program = programPrefix(segment, shell);
  if (!program || program.executable.toLowerCase() !== segment.tokens[0].toLowerCase()) {
    return null;
  }
  const bare = !/[\\/]/.test(program.executable) &&
    !/^[a-zA-Z]:/.test(program.executable);
  const executable = canonicalExecutableToken(program.executable, { platform: 'windows' });
  const recognizedAlias = bare && rule.executables.some(
    (name) => canonicalExecutableToken(name, { platform: 'windows' }) === executable,
  );
  const pinned = rule.execution.type === 'pinned' &&
    program.executable.toLowerCase() === rule.execution.path.toLowerCase();
  if (!recognizedAlias && !pinned) return null;
  if (!matchingArguments(segment.tokens, rule)) return null;
  if (shell === 'cmd' && /[%!^]/.test(segment.source)) return null;
  return {
    id: rule.id,
    replacement: rule.execution.type === 'pinned'
      ? `& '${rule.execution.path.replaceAll("'", "''")}'` : null,
    prefixLength: program.source.length,
  };
}

export function evaluateTrustedCommand(command, shell, environment,
  { file = DEFAULT_TRUSTED_COMMANDS_FILE, snapshot = null } = {}) {
  if (environment?.platform !== 'windows' ||
      environment?.permissionProfile !== 'workspace-write') return null;
  const { rules, error } = snapshot || loadTrustedCommands(file);
  if (error) return { matched: false, reason: error };
  const shellKind = effectiveShell({ shell }, environment);
  if (!SHELLS.has(shellKind)) return { matched: false, reason: 'unsupported Shell' };
  // CMD /s /c may wrap a single quoted executable in one extra pair of quotes.
  // Preserve this form only for one command, where we dispatch via PowerShell.
  const cmdOuter = shellKind === 'cmd' && /^""[a-zA-Z]:\\/.test(command) &&
    command.endsWith('"');
  const normalized = cmdOuter ? command.slice(1, -1) : command;
  const parsed = parseShellCommand(normalized, { shell: shellKind });
  if (!parsed?.segments.length || parsed.sourceBound === false ||
      parsed.operators.includes('|')) {
    return { matched: false, reason: 'unrecognized shell syntax or pipeline' };
  }
  const matches = [];
  for (const segment of parsed.segments) {
    const matched = rules
      .filter((rule) => rule.platform === environment.platform &&
        rule.permission_profile === environment.permissionProfile)
      .map((rule) => matchSegment(segment, rule, shellKind))
      .find(Boolean);
    if (!matched) return { matched: false, reason: 'at least one command is not trusted' };
    matches.push(matched);
  }
  const pins = matches.some((match) => match.replacement !== null);
  if (shellKind === 'cmd' && pins && parsed.segments.length !== 1) {
    return { matched: false, reason: 'compound CMD pinned-executable rewriting is unsupported' };
  }
  let rewritten = normalized;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    if (!match.replacement) continue;
    const segment = parsed.segments[i];
    const start = segment.start;
    rewritten = rewritten.slice(0, start) + match.replacement +
      rewritten.slice(start + match.prefixLength);
  }
  return {
    matched: true,
    rule_ids: [...new Set(matches.map((match) => match.id))],
    cmd: rewritten,
    ...(shellKind === 'cmd' && pins ? { shell: 'powershell.exe' } : {}),
  };
}

const TAILSCALE_PIPE_DENIED = /failed to connect to local tailscaled[^\r\n]*(?:Access is denied|拒绝访问)/i;

export function trustedCommandDenialHint({ command, output, environment, trusted = false }) {
  if (trusted || environment?.platform !== 'windows' ||
      environment?.permissionProfile !== 'workspace-write' ||
      !/\btailscale(?:\.exe)?\b/i.test(command || '') ||
      !TAILSCALE_PIPE_DENIED.test(output || '')) return null;
  return '[CCM command trust hint] Tailscale service access was denied in a restricted command. ' +
    'Review ccm.config.json trusted_commands and use an invocation whose every command segment ' +
    'matches a trusted rule; unsupported syntax remains sandboxed.';
}
