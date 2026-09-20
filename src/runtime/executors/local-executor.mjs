import fs from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PTY_PROXY_PATH = fileURLToPath(
  new URL('../../../native/bin/ccm-pty-proxy.exe', import.meta.url),
);

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
      child.kill();
    },
    get stdinWritable() {
      return Boolean(child.stdin?.writable);
    },
  };
}

export class LocalEnvironmentExecutor {
  constructor({ sandboxBackend, ptyProxyPath = DEFAULT_PTY_PROXY_PATH }) {
    this.sandboxBackend = sandboxBackend;
    this.ptyProxyPath = ptyProxyPath;
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
    const invocation = this.sandboxBackend.buildInvocation({
      environment,
      command,
      cwd,
      shell,
      permissionProfile,
    });

    if (tty) {
      if (!fs.existsSync(this.ptyProxyPath)) {
        throw new Error(
          'CCM PTY proxy is missing. Run "npm run build:native" before using tty=true.',
        );
      }

      const child = spawnChild(
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
          env: { ...process.env },
        },
      );

      return {
        sandboxed: invocation.sandboxed,
        ...wirePipeChild(child, onData, onExit),
      };
    }

    const child = spawnChild(invocation.file, invocation.args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    return {
      sandboxed: invocation.sandboxed,
      ...wirePipeChild(child, onData, onExit),
    };
  }
}
