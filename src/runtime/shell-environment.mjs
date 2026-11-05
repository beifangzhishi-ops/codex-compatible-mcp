// Port of portions of Apache-2.0-licensed openai/codex @
// ed8eac40832e6a79f30eaeb3c521912f231d43eb.
// See third_party/openai-codex/LICENSE.
// codex-rs/protocol/src/shell_environment.rs and config_types.rs.
// Keep the order of these operations aligned with upstream populate_env.

export const CODEX_THREAD_ID_ENV_VAR = 'CODEX_THREAD_ID';
export const CODEX_TOOL_CALL_ID_ENV_VAR = 'CODEX_TOOL_CALL_ID';

export const NON_INHERITABLE_ENV_VARS = Object.freeze([
  'CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN',
  'NODE_REPL_AUTH_TOKEN',
  'CODEX_GUARDIAN_DECISIONS_API_KEY',
  'OPENAI_FEDERATION_RULE_ID',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
]);

export const WINDOWS_CORE_ENV_VARS = Object.freeze([
  'PATH', 'PATHEXT', 'SHELL', 'COMSPEC', 'SYSTEMROOT', 'WINDIR',
  'SYSTEMDRIVE', 'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'HOMEDRIVE',
  'HOMEPATH', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'PROGRAMDATA', 'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'TMPDIR',
  'POWERSHELL', 'PWSH',
]);

export const UNIX_CORE_ENV_VARS = Object.freeze([
  'PATH', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'LOGNAME', 'USER',
]);

const DEFAULT_EXCLUDES = Object.freeze(['*KEY*', '*SECRET*', '*TOKEN*']);
const NON_INHERITABLE = new Set(NON_INHERITABLE_ENV_VARS);
const isWindows = (platform) => platform === 'win32' || platform === 'windows';
const equalEnvName = (a, b, platform) =>
  isWindows(platform) ? a.toUpperCase() === b.toUpperCase() : a === b;

// Codex's EnvironmentVariablePattern is a case-insensitive WildMatchPattern
// with '*' and '?' wildcard tokens, not a regular expression.
export function matchesEnvironmentPattern(name, pattern) {
  if (typeof pattern !== 'string') throw new TypeError('Environment pattern must be a string.');
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&');
  const wildcard = escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
  return new RegExp('^' + wildcard + '$', 'iu').test(name);
}

function matchesAny(name, patterns) {
  return patterns.some((pattern) => matchesEnvironmentPattern(name, pattern));
}

export function isNonInheritableEnvVar(name) {
  return NON_INHERITABLE.has(String(name).toUpperCase());
}

function removeEquivalent(env, name, platform) {
  for (const key of Object.keys(env)) {
    if (equalEnvName(key, name, platform)) delete env[key];
  }
}

export function setToolCallIdEnvVar(env, toolCallId, { platform = process.platform } = {}) {
  removeEquivalent(env, CODEX_TOOL_CALL_ID_ENV_VAR, platform);
  if (toolCallId != null && !String(toolCallId).includes('\0')) {
    env[CODEX_TOOL_CALL_ID_ENV_VAR] = String(toolCallId);
  }
  return env;
}

// The input is an already parsed ShellEnvironmentPolicy. TOML configuration
// deserialization belongs to the Codex config layer, not to this pure evaluator.
export function populateShellEnvironment(vars, policy = {}, {
  platform = process.platform,
  threadId = null,
} = {}) {
  const inherit = policy.inherit || 'all';
  if (!['all', 'core', 'none'].includes(inherit)) {
    throw new Error('Unsupported Codex shell environment inherit strategy: ' + inherit);
  }
  const env = {};
  const entries = vars instanceof Map ? vars.entries() : Object.entries(vars);
  const core = isWindows(platform) ? WINDOWS_CORE_ENV_VARS : UNIX_CORE_ENV_VARS;

  // 1. Inheritance: all / core / none.
  if (inherit !== 'none') {
    for (const [name, value] of entries) {
      if (inherit === 'all' ||
          core.some((allowed) => allowed.toUpperCase() === name.toUpperCase())) {
        env[name] = value;
      }
    }
  }

  // 2. Default excludes, disabled by default upstream.
  if (policy.ignore_default_excludes === false) {
    for (const key of Object.keys(env)) {
      if (matchesAny(key, DEFAULT_EXCLUDES)) delete env[key];
    }
  }

  // 3. User-defined exclude patterns.
  const excludes = policy.exclude || [];
  for (const key of Object.keys(env)) {
    if (matchesAny(key, excludes)) delete env[key];
  }

  // 4. Overrides (case-insensitive name replacement on Windows).
  for (const [name, value] of Object.entries(policy.set || {})) {
    if (isWindows(platform)) removeEquivalent(env, name, platform);
    env[name] = value;
  }

  // 5. include_only is a filter, never a mechanism for restoring excludes.
  const includeOnly = policy.include_only || [];
  if (includeOnly.length) {
    for (const key of Object.keys(env)) {
      if (!matchesAny(key, includeOnly)) delete env[key];
    }
  }

  // 6. Runtime-injected thread ID comes after include_only.
  if (threadId != null) {
    env[CODEX_THREAD_ID_ENV_VAR] = String(threadId);
  }

  // 7. Launch-context credentials cannot be reintroduced by policy.set.
  for (const key of Object.keys(env)) {
    if (isNonInheritableEnvVar(key)) delete env[key];
  }
  return env;
}

export function createShellEnvironment(vars, policy = {}, options = {}) {
  const env = populateShellEnvironment(vars, policy, options);
  if (isWindows(options.platform || process.platform) &&
      !Object.keys(env).some((key) => key.toUpperCase() === 'PATHEXT')) {
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  }
  return env;
}
