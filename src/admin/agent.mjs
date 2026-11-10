import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADMIN_KEY_FILE, adminPipeName, compareAdminKey, pipeFrames, sendPipeFrame } from '../runtime/admin/pipe-protocol.mjs';

function terminateTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, timeout: 10_000, stdio: 'ignore',
    });
    if (result.status === 0) return;
  }
  try { child.kill(); } catch {}
}

export function createAdministratorServer({
  key,
  pipeName = adminPipeName(),
  spawnProcess = spawn,
  terminate = terminateTree,
} = {}) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) {
    throw new Error('Administrator server requires a 256-bit local IPC key.');
  }
  const active = new Set();
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    let child = null;
    let started = false;
    let exited = false;
    const fail = (message) => {
      sendPipeFrame(socket, { type: 'error', message });
      socket.end();
    };
    socket.on('data', pipeFrames((frame) => {
      if (!started) {
        if (frame?.type !== 'start' || !compareAdminKey(key, frame.key)) {
          fail('Administrator IPC authentication failed.');
          return;
        }
        if (active.size >= 64) return fail('Administrator agent process limit reached.');
        if (typeof frame.file !== 'string' || !frame.file ||
            !Array.isArray(frame.args) || !frame.args.every((arg) => typeof arg === 'string') ||
            typeof frame.cwd !== 'string' || !frame.cwd ||
            !frame.env || Array.isArray(frame.env) || typeof frame.env !== 'object' ||
            !Object.entries(frame.env).every(([name, value]) =>
              typeof value === 'string' && !/^CCM_/i.test(name))) {
          return fail('Invalid administrator command request.');
        }
        started = true;
        try {
          child = spawnProcess(frame.file, frame.args, {
            cwd: frame.cwd, env: frame.env,
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          });
        } catch (error) {
          return fail(String(error.message));
        }
        active.add(child);
        sendPipeFrame(socket, { type: 'started' });
        const output = (data) => sendPipeFrame(socket, { type: 'output', data: Buffer.from(data).toString('base64') });
        child.stdout?.on('data', output);
        child.stderr?.on('data', output);
        child.on('error', (error) => {
          if (!exited) fail(`Unable to start administrator command: ${error.message}`);
        });
        child.on('close', (code) => {
          exited = true;
          active.delete(child);
          sendPipeFrame(socket, { type: 'exit', code });
          socket.end();
        });
      } else if (frame?.type === 'input' && typeof frame.data === 'string') {
        if (child?.stdin?.writable) child.stdin.write(Buffer.from(frame.data, 'base64'));
      } else if (frame?.type === 'kill') {
        terminate(child);
      } else {
        fail('Invalid administrator IPC operation.');
        terminate(child);
      }
    }, (error) => { fail(error.message); terminate(child); }));
    socket.on('close', () => { if (!exited) terminate(child); });
    socket.on('error', () => { if (!exited) terminate(child); });
  });
  server.on('close', () => { for (const child of active) terminate(child); });
  return server;
}

function ensureAdministrator() {
  if (process.platform !== 'win32') throw new Error('CCM administrator agent requires Windows.');
  const check = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    '$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 } else { exit 1 }',
  ], { windowsHide: true, timeout: 10_000 });
  if (check.status !== 0) throw new Error('Administrator agent must start with an elevated Windows token.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureAdministrator();
  const key = fs.readFileSync(ADMIN_KEY_FILE, 'utf8').trim();
  const server = createAdministratorServer({ key });
  server.listen(adminPipeName());
}
