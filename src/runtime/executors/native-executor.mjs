import fs from 'node:fs';
import {
  spawn as spawnChild,
  spawnSync as spawnSyncChild,
} from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildProxyEnvironment } from '../proxy-env.mjs';

const DEFAULT_PTY_PROXY_PATH = fileURLToPath(
  new URL('../../../native/bin/ccm-pty-proxy.exe', import.meta.url),
);

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
    baseEnv = process.env,
    spawnProcess = spawnChild,
    fileExists = fs.existsSync,
  }) {
    this.sandboxBackend = sandboxBackend;
    this.childProxyPolicy = childProxyPolicy;
    this.ptyProxyPath = ptyProxyPath;
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
