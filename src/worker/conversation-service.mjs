import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProxyEnvironment } from '../runtime/proxy-env.mjs';
import { readWorkerCaBundle } from '../runtime/ccm-config.mjs';

const TOOL = fileURLToPath(new URL('../../tools/conversation/conversation.py', import.meta.url));
const MAX_RESULT_BYTES = 512 * 1024;
const TIMEOUT_MS = 120_000;

export function conversationChildEnvironment(args, {
  baseEnv = process.env,
  proxyMode = 'proxy',
  proxySpawn,
  caBundle = readWorkerCaBundle(),
} = {}) {
  const env = buildProxyEnvironment(baseEnv, {
    mode: proxyMode,
    ...(proxySpawn ? { spawn: proxySpawn } : {}),
  });
  Object.assign(env, caBundle);
  env.PYTHONUTF8 = '1';
  env.CCM_CONVERSATION_PROXY_MODE = proxyMode;
  if (args.proxy !== undefined) {
    const proxy = new URL(args.proxy);
    if (!['http:', 'https:'].includes(proxy.protocol)) {
      throw new Error('Conversation proxy must be HTTP or HTTPS.');
    }
    env.HTTP_PROXY = proxy.href;
    env.HTTPS_PROXY = proxy.href;
    env.http_proxy = proxy.href;
    env.https_proxy = proxy.href;
    env.CCM_CONVERSATION_PROXY_MODE = 'proxy';
  }
  return env;
}

/**
 * Trusted, read-oriented Worker service. It never invokes the command sandbox,
 * and unlike exec_command, it cannot run a caller-supplied program or path.
 * The Python implementation validates the limited actions and writes only
 * normalized imported snapshots and exports beneath CCM's ignored state/cache.
 */
export function runConversationAction(args, {
  executable = process.platform === 'win32' ? 'python.exe' : 'python3',
  tool = TOOL,
  spawnProcess = spawn,
  proxyMode = 'proxy',
} = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Conversation arguments must be an object.');
  }
  const input = JSON.stringify(args);
  if (Buffer.byteLength(input, 'utf8') > 64 * 1024) {
    throw new Error('Conversation request is too large.');
  }
  const env = conversationChildEnvironment(args, { proxyMode });
  return new Promise((resolve, reject) => {
    let settled = false;
    let data = '';
    let errors = '';
    const child = spawnProcess(executable, [tool], {
      cwd: path.dirname(tool),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    const timer = setTimeout(() => {
      child.kill();
      done(new Error('Conversation action timed out.'));
    }, TIMEOUT_MS);
    function done(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    child.on('error', done);
    child.stdout.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data, 'utf8') > MAX_RESULT_BYTES) {
        child.kill();
        done(new Error('Conversation response exceeded the permitted size.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      if (errors.length < 4000) errors += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (settled) return;
      let value;
      try { value = JSON.parse(data); }
      catch {
        done(new Error('Conversation reader returned invalid JSON' +
          (errors ? ': ' + errors.slice(0, 1000) : '.')));
        return;
      }
      if (code !== 0 || value.status === 'error') {
        done(new Error(String(value.error || errors || 'Conversation reader failed.')));
      } else {
        done(null, value);
      }
    });
    child.stdin.end(input);
  });
}
