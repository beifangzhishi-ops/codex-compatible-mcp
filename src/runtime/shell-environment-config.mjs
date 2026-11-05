// TOML policy conversion port: Apache-2.0-licensed openai/codex @
// ed8eac40832e6a79f30eaeb3c521912f231d43eb
// See third_party/openai-codex/LICENSE.
// codex-rs/config/src/shell_environment_policy.rs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

const fields = new Set([
  'inherit', 'ignore_default_excludes', 'exclude', 'set', 'include_only',
  'filters', 'experimental_use_profile',
]);

function stringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('shell_environment_policy.' + field + ' must be a list of patterns.');
  }
  return value;
}

export function parseCodexShellEnvironmentPolicy(configText) {
  const source = parse(configText);
  const value = source.shell_environment_policy || {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('shell_environment_policy must be a table.');
  }
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error('Unknown shell_environment_policy field: ' + field);
  }
  const inherit = value.inherit ?? 'all';
  if (!['all', 'core', 'none'].includes(inherit)) {
    throw new Error('Unsupported shell_environment_policy.inherit: ' + inherit);
  }
  const ignoreDefaultExcludes = value.ignore_default_excludes ?? true;
  if (typeof ignoreDefaultExcludes !== 'boolean') {
    throw new Error('shell_environment_policy.ignore_default_excludes must be boolean.');
  }
  if (value.filters !== undefined &&
      (value.exclude !== undefined || value.include_only !== undefined)) {
    throw new Error('cannot mix filters with exclude or include_only.');
  }
  let exclude = stringArray(value.exclude, 'exclude');
  let includeOnly = stringArray(value.include_only, 'include_only');
  if (value.filters !== undefined) {
    if (!value.filters || typeof value.filters !== 'object' ||
        Array.isArray(value.filters)) throw new Error('filters must be a TOML table.');
    exclude = [];
    includeOnly = [];
    const seen = new Set();
    for (const [pattern, operation] of Object.entries(value.filters)) {
      const key = pattern.toLowerCase();
      if (seen.has(key)) {
        throw new Error('Duplicate shell environment filter ignoring case: ' + pattern);
      }
      seen.add(key);
      if (operation === 'include') includeOnly.push(pattern);
      else if (operation === 'exclude') exclude.push(pattern);
      else throw new Error('Unknown shell environment filter action: ' + operation);
    }
  }
  const set = value.set || {};
  if (!set || typeof set !== 'object' || Array.isArray(set) ||
      !Object.values(set).every((item) => typeof item === 'string')) {
    throw new Error('shell_environment_policy.set must be a table of strings.');
  }
  const experimentalUseProfile = value.experimental_use_profile ?? false;
  if (typeof experimentalUseProfile !== 'boolean') {
    throw new Error('shell_environment_policy.experimental_use_profile must be boolean.');
  }
  return {
    inherit,
    ignore_default_excludes: ignoreDefaultExcludes,
    exclude,
    set: { ...set },
    include_only: includeOnly,
    use_profile: experimentalUseProfile,
  };
}

export function codexConfigPath(env = process.env, home = os.homedir()) {
  return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
}

export function readCodexShellEnvironmentPolicy({
  file = codexConfigPath(),
} = {}) {
  try {
    return parseCodexShellEnvironmentPolicy(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return parseCodexShellEnvironmentPolicy('');
    throw error;
  }
}
