import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIX_V = 'DESKTOP-KFL6V1F';
const LOCAL_TOOLS = Object.freeze({
  qq: 'C:\\Users\\Songjx\\Documents\\ChatGPT\\QQBridge\\qq.exe',
  wechat: 'C:\\Users\\Songjx\\Documents\\ChatGPT\\WXBridge\\WXBridge.exe',
  sjtu_mail: 'C:\\Users\\Songjx\\AppData\\Local\\Programs\\himalaya\\himalaya.exe',
});
const TRANSCRIBE_SCRIPT = fileURLToPath(
  new URL('../../tools/faster-whisper/transcribe.py', import.meta.url),
);
const OUTPUT_LIMIT = 20 * 1024 * 1024;

function cliChildEnv() {
  // Fixed-function app integrations must not inherit internal CCM bootstrap secrets.
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^CCM_/i.test(key)),
  );
}

export function resolveCliInvocation(tool, args, { environmentId, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('CLI passthrough requires a Windows Worker.');
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
    throw new Error('CLI arguments must be an array of strings.');
  }
  if (tool === 'transcribe') {
    // Use the Python 3.9 environment where Faster Whisper is installed on 6v.
    // py.exe is also available for deployment on other Windows Workers.
    const launcher = path.win32.join(process.env.WINDIR || 'C:\\Windows', 'py.exe');
    return {
      executable: launcher,
      argv: ['-3.9', '-X', 'utf8', TRANSCRIBE_SCRIPT, ...args],
      cwd: path.dirname(TRANSCRIBE_SCRIPT),
    };
  }
  const executable = LOCAL_TOOLS[tool];
  if (!executable) throw new Error('Unknown CLI passthrough tool: ' + tool);
  if (environmentId !== SIX_V) {
    throw new Error(tool + ' is available only on 6v (' + SIX_V + ').');
  }
  return { executable, argv: args, cwd: path.win32.dirname(executable) };
}

export async function runCliPassthrough(
  { tool, args = [], timeout_seconds = 120, environment_id } = {},
  { executableExists = existsSync, spawnProcess = spawn, resolveInvocation = resolveCliInvocation } = {},
) {
  const invocation = resolveInvocation(tool, args, { environmentId: environment_id });
  if (!executableExists(invocation.executable) ||
      (tool === 'transcribe' && !executableExists(TRANSCRIBE_SCRIPT))) {
    return { missing: true, stdout: '', stderr: '', exit_code: null };
  }
  const timeoutMs = Math.round(Number(timeout_seconds) * 1000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
    throw new Error('Invalid CLI timeout.');
  }
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    try {
      child = spawnProcess(invocation.executable, invocation.argv, {
        cwd: invocation.cwd,
        env: cliChildEnv(),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        resolve({ missing: true, stdout: '', stderr: '', exit_code: null });
      } else {
        reject(error);
      }
      return;
    }
    const stdout = [];
    const stderr = [];
    let size = 0;
    let ended = false;
    let timedOut = false;
    let overflow = false;
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const append = (destination, chunk) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        overflow = true;
        child.kill();
        return;
      }
      destination.push(chunk);
    };
    child.stdout.on('data', chunk => append(stdout, chunk));
    child.stderr.on('data', chunk => append(stderr, chunk));
    child.once('error', error => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        resolve({ missing: true, stdout: '', stderr: '', exit_code: null });
      } else {
        reject(error);
      }
    });
    child.once('close', (exitCode, signal) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exit_code: exitCode,
        ...(signal ? { signal } : {}),
        ...(timedOut ? { timed_out: true } : {}),
        ...(overflow ? { output_limit_exceeded: true } : {}),
      });
    });
  });
}
