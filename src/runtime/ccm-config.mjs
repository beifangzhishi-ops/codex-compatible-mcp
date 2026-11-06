import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CCM_CONFIG_FILE = fileURLToPath(
  new URL('../../ccm.config.json', import.meta.url),
);

const SECTIONS = [
  'controller', 'worker', 'trusted_commands', 'restart_allowlist',
  'worker_quarantine_errors', 'codex',
];

/**
 * The one CCM runtime configuration source on each host.
 * Callers requiring live authorization must call this on every decision.
 */
export function readCcmConfig(file = DEFAULT_CCM_CONFIG_FILE) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  if (!value || Array.isArray(value) || typeof value !== 'object' ||
      value.version !== 1) {
    throw new Error('Invalid CCM configuration version in ' + file);
  }
  for (const key of SECTIONS) {
    if (!value[key] || Array.isArray(value[key]) ||
        typeof value[key] !== 'object') {
      throw new Error('Invalid CCM configuration section: ' + key);
    }
  }
  return value;
}

export function readCcmSection(section, file = DEFAULT_CCM_CONFIG_FILE) {
  if (!SECTIONS.includes(section)) {
    throw new Error('Invalid CCM configuration section: ' + section);
  }
  return readCcmConfig(file)[section];
}

/** Load only documented process bootstrap variables; do not export secrets into user commands. */
export function applyCcmBootstrapEnv(section, env = process.env, file = DEFAULT_CCM_CONFIG_FILE) {
  if (section !== 'controller' && section !== 'worker') {
    throw new Error('Unsupported CCM bootstrap section');
  }
  const values = readCcmSection(section, file).env;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error('CCM ' + section + '.env must be an object');
  }
  for (const [name, value] of Object.entries(values)) {
    if (!/^CCM_[A-Z0-9_]+$/u.test(name) || !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error('Invalid CCM bootstrap setting: ' + name);
    }
    env[name] = String(value);
  }
  return env;
}

export function readWorkerCaBundle(file = DEFAULT_CCM_CONFIG_FILE) {
  const childEnv = readCcmSection('worker', file).child_env || {};
  const keys = Object.keys(childEnv);
  if (keys.some(key => key !== 'CURL_CA_BUNDLE')) {
    throw new Error('Only CURL_CA_BUNDLE is supported under worker.child_env');
  }
  const bundle = childEnv.CURL_CA_BUNDLE;
  if (bundle == null || bundle === '') return {};
  if (typeof bundle !== 'string' ||
      !(path.isAbsolute(bundle) || path.win32.isAbsolute(bundle))) {
    throw new Error('worker.child_env.CURL_CA_BUNDLE must be an absolute path');
  }
  if (!fs.existsSync(bundle)) {
    throw new Error('CURL_CA_BUNDLE file not found: ' + bundle);
  }
  return { CURL_CA_BUNDLE: bundle };
}
