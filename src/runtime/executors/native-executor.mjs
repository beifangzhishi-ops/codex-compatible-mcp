import fs from 'node:fs';
import path from 'node:path';
import {
  spawn as spawnChild,
  spawnSync as spawnSyncChild,
} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildProxyEnvironment } from '../proxy-env.mjs';

const DEFAULT_PTY_PROXY_PATH = fileURLToPath(
  new URL('../../../native/bin/ccm-pty-proxy.exe', import.meta.url),
);
const DEFAULT_CHILD_ENV_PATH = fileURLToPath(
  new URL('../../../config/child.env', import.meta.url),
);

function readChildEnvironment(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  const env = {};
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^CURL_CA_BUNDLE\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid config/child.env entry on line ${index + 1}: only CURL_CA_BUNDLE is supported.`);
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value || !(path.isAbsolute(value) || path.win32.isAbsolute(value))) {
      throw new Error('CURL_CA_BUNDLE in config/child.env must be an absolute path.');
    }
    if (!fs.existsSync(value)) {
      throw new Error(`CURL_CA_BUNDLE file not found: ${value}`);
    }
    env.CURL_CA_BUNDLE = value;
  }
  return env;
}

export function killChildProcessTree(
  child,
  {
    platform = process.platform,
    spawnSync = spawnSyncChild,
  } = {},
) {
  if (!child) return;

  if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    const result = spawnSync(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      {
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    if (!result?.error && result?.status === 0) return;
  }

  try {
    child.kill();
  } catch {}
}

function wirePipeChild(child, onData, onExit) {
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', onExit);

  return {
    write(chars) {
      if (!child.stdin?.writable) {
        throw new Error('Process stdin is not writable.');
      }
      child.stdin.write(chars);
    },
    kill() {
      killChildProcessTree(child);
    },
    get stdinWritable() {
      return Boolean(child.stdin?.writable);
    },
  };
}

export class NativeEnvironmentExecutor {
  constructor({
    sandboxBackend,
    childProxyPolicy,
    ptyProxyPath = DEFAULT_PTY_PROXY_PATH,
    childEnvPath = DEFAULT_CHILD_ENV_PATH,
    baseEnv = process.env,
    spawnProcess = spawnChild,
    fileExists = fs.existsSync,
  }) {
    this.sandboxBackend = sandboxBackend;
    this.childProxyPolicy = childProxyPolicy;
    this.ptyProxyPath = ptyProxyPath;
    this.childEnvPath = childEnvPath;
    this.baseEnv = baseEnv;
    this.spawnProcess = spawnProcess;
    this.fileExists = fileExists;
  }

  startProcess({
    environment,
    command,
    cwd,
    shell,
    permissionProfile,
    tty,
    onData,
    onExit,
  }) {
    const childEnv = buildProxyEnvironment(this.baseEnv, {
      mode: this.childProxyPolicy?.getMode?.() || 'proxy',
    });
    Object.assign(childEnv, readChildEnvironment(this.childEnvPath));
    const invocation = this.sandboxBackend.buildInvocation({
      environment,
      command,
      cwd,
      shell,
      permissionProfile,
    });

    if (tty) {
      if (!this.fileExists(this.ptyProxyPath)) {
        throw new Error(
          'CCM PTY proxy is missing. Run "npm run build:native" before using tty=true.',
        );
      }

      const child = this.spawnProcess(
        this.ptyProxyPath,
        [
          '--cwd',
          cwd,
          '--cols',
          '120',
          '--rows',
          '30',
          '--',
          invocation.file,
          ...invocation.args,
        ],
        {
          cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childEnv,
        },
      );

      return {
        sandboxed: invocation.sandboxed,
        ...wirePipeChild(child, onData, onExit),
      };
    }

    const child = this.spawnProcess(invocation.file, invocation.args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,
    });

    return {
      sandboxed: invocation.sandboxed,
      ...wirePipeChild(child, onData, onExit),
    };
  }
}
