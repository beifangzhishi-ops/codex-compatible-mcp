import { spawn } from 'node:child_process';

const children = new Set();
let stopping = false;

function start(label, file) {
  const child = spawn(process.execPath, [file], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(
        label + ' exited unexpectedly (' +
        (signal ? 'signal ' + signal : 'code ' + code) + ').',
      );
      shutdown(code || 1);
    }
  });
  return child;
}

async function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {}
  }
  setTimeout(() => process.exit(exitCode), 100).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('CCM Controller', 'src/index.mjs');

await new Promise((resolve) => setTimeout(resolve, 500));

start('CCM OAuth sidecar', 'ccm-sidecar/server.mjs');

await new Promise(() => {});
