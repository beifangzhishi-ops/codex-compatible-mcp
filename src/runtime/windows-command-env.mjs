import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WINDOWS_ENVIRONMENT_KEYS = {
  Machine: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  User: 'HKCU\\Environment',
};

function readRegistryEnvironment(scope, baseEnv, spawn = spawnSync) {
  const systemRoot = baseEnv.SystemRoot || baseEnv.SYSTEMROOT || 'C:\\Windows';
  const regExe = path.win32.join(systemRoot, 'System32', 'reg.exe');
  const result = spawn(regExe, ['query', WINDOWS_ENVIRONMENT_KEYS[scope]], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to read Windows ${scope} environment from registry: ${result.error?.code || result.status}`);
  }
  const values = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s{4}(.+?)\s+REG_(SZ|EXPAND_SZ)\s*(.*)$/.exec(line);
    if (match) values.set(match[1].toUpperCase(), {
      name: match[1],
      value: match[3],
      expand: match[2] === 'EXPAND_SZ',
    });
  }
  return values;
}

function setInsensitive(env, name, value) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name.toUpperCase() && key !== name) delete env[key];
  }
  env[name] = value;
}

function getInsensitive(env, name) {
  const key = Object.keys(env).find((item) => item.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function expandWindows(value, env) {
  return value.replace(/%([^%]+)%/g, (original, name) => {
    return getInsensitive(env, name) ?? original;
  });
}

export function readCurrentCommandEnvironment(
  baseEnv,
  { platform = process.platform, readRegistry = (scope) => readRegistryEnvironment(scope, baseEnv) } = {},
) {
  if (platform !== 'win32') return { ...baseEnv };

  const machine = readRegistry('Machine');
  const user = readRegistry('User');
  const env = { ...baseEnv };

  // Windows combines machine PATH first and user PATH second; other user variables
  // override their machine counterparts. Internal CCM controls remain process-owned.
  for (const values of [machine, user]) {
    for (const [key, entry] of values) {
      if (key === 'PATH' || key.startsWith('CCM_')) continue;
      const value = entry.expand ? expandWindows(entry.value, env) : entry.value;
      setInsensitive(env, entry.name, value);
    }
  }

  const machinePath = machine.get('PATH');
  const userPath = user.get('PATH');
  if (machinePath || userPath) {
    const parts = [machinePath, userPath].filter(Boolean).map((entry) =>
      entry.expand ? expandWindows(entry.value, env) : entry.value);
    setInsensitive(env, 'Path', parts.filter(Boolean).join(';'));
  }
  return env;
}

export const windowsCommandEnvInternals = { readRegistryEnvironment };
