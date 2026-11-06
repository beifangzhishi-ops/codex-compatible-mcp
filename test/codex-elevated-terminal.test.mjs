// Opt-in end-to-end check of the staged upstream Codex Windows sandbox's
// interactive PTY path. It is intentionally NOT a normal CCM Worker test:
// Codex's native Windows provisioning requires a trusted elevated host.
// The scenario exercises actual ProcessManager -> NativeEnvironmentExecutor
// -> CCM ConPTY proxy -> Codex sandbox -> restricted child semantics.
//
// Upstream sandbox review: openai/codex
// f79b26ccbb3116b052544666a181012fb45dc49b.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerRuntime } from '../src/runtime/index.mjs';

const enabled = process.platform === 'win32' &&
  process.env.CCM_RUN_CODEX_ELEVATED_TERMINAL === '1';
const root = fileURLToPath(new URL('../', import.meta.url));

function fixtureRuntime(t) {
  const cache = path.join(root, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(cache, 'codex-tty-integration-'));
  const workspace = path.join(fixture, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  // The trusted Worker owns the dedicated CODEX_HOME; this test never
  // rewrites interactive Codex settings or makes an unapproved sandbox default.
  let runtime;
  try {
    runtime = createWorkerRuntime({
      codexSandbox: true,
      environment: {
        id: 'codex-tty-integration',
        cwd: workspace,
        permissionProfile: 'workspace-write',
      },
      workspaceStateFile: null,
      seedBootstrapWorkspace: false,
    });
  } catch (error) {
    fs.rmSync(fixture, { recursive: true, force: true });
    throw error;
  }
  t.after(() => {
    runtime.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  return { runtime, workspace };
}

async function pollUntil(manager, first, condition, { limitMs = 25_000 } = {}) {
  let current = first;
  let output = String(first.output ?? '');
  const end = Date.now() + limitMs;
  while (!condition({ ...current, output }) &&
      current.session_id !== undefined && Date.now() < end) {
    current = await manager.writeStdin({
      session_id: current.session_id,
      chars: '',
      yield_time_ms: 1000,
    });
    output += current.output ?? '';
  }
  return { ...current, output };
}

test('Codex sandbox PTY accepts repeated stdin and streams output before exit', {
  skip: !enabled && 'requires a trusted Windows host and explicit terminal integration opt-in',
  timeout: 90_000,
}, async (t) => {
  const { runtime } = fixtureRuntime(t);
  const manager = runtime.processManager;
  let first = await manager.execCommand({
    cmd: 'echo CCM_TTY_READY & set /p CCM_FIRST= & echo CCM_TTY_NEXT & set /p CCM_SECOND= & echo CCM_TTY_DONE',
    shell: 'cmd.exe',
    tty: true,
    yield_time_ms: 250,
  });
  first = await pollUntil(manager, first, (result) => result.output.includes('CCM_TTY_READY'));
  assert.match(first.output, /CCM_TTY_READY/, 'first prompt never streamed');
  assert.equal(typeof first.session_id, 'number', 'PTY command exited before stdin arrived');

  let next = await manager.writeStdin({
    session_id: first.session_id,
    chars: 'ccm_first_line\n',
    yield_time_ms: 1000,
  });
  next = await pollUntil(manager, next, (result) => result.output.includes('CCM_TTY_NEXT'));
  assert.match(next.output, /CCM_TTY_NEXT/, 'first input did not advance the PTY session');
  assert.equal(typeof next.session_id, 'number', 'PTY closed before the second input');

  let final = await manager.writeStdin({
    session_id: next.session_id,
    chars: 'ccm_second_line\n',
    yield_time_ms: 1000,
  });
  final = await pollUntil(manager, final, (result) => result.session_id === undefined);
  assert.match(final.output, /CCM_TTY_DONE/, 'second input did not reach the terminal');
  assert.equal(final.exit_code, 0, 'interactive command did not exit normally');
});

test('Codex sandbox PTY forwards Ctrl+C and ends the same live session', {
  skip: !enabled && 'requires a trusted Windows host and explicit terminal integration opt-in',
  timeout: 90_000,
}, async (t) => {
  const { runtime } = fixtureRuntime(t);
  const manager = runtime.processManager;
  let first = await manager.execCommand({
    cmd: 'Write-Output CCM_CTRL_C_READY; while ($true) { Start-Sleep -Milliseconds 250 }',
    tty: true,
    yield_time_ms: 250,
  });
  first = await pollUntil(manager, first, (result) => result.output.includes('CCM_CTRL_C_READY'));
  assert.match(first.output, /CCM_CTRL_C_READY/);
  assert.equal(typeof first.session_id, 'number');

  const afterSignal = await manager.writeStdin({
    session_id: first.session_id,
    chars: '\x03',
    yield_time_ms: 1000,
  });
  const done = await pollUntil(manager, afterSignal,
    (result) => result.session_id === undefined, { limitMs: 15_000 });
  assert.equal(done.session_id, undefined, 'Ctrl+C did not interrupt the running PTY session');
  // Windows may report a Ctrl+C signal instead of a numeric exit code.
  // The important contract is that the live session actually terminates.
});

test('Codex sandbox PTY cancellation kills its command tree, not just the wrapper', {
  skip: !enabled && 'requires a trusted Windows host and explicit terminal integration opt-in',
  timeout: 90_000,
}, async (t) => {
  const { runtime, workspace } = fixtureRuntime(t);
  const manager = runtime.processManager;
  const marker = path.join(workspace, 'late-marker.txt');
  const quoted = marker.replaceAll("'", "''");
  let first = await manager.execCommand({
    cmd: "Write-Output CCM_CANCEL_READY; Start-Sleep -Seconds 4; Set-Content -LiteralPath '" +
      quoted + "' -Value SURVIVED",
    tty: true,
    yield_time_ms: 250,
  });
  first = await pollUntil(manager, first, (result) => result.output.includes('CCM_CANCEL_READY'));
  assert.match(first.output, /CCM_CANCEL_READY/);
  assert.equal(typeof first.session_id, 'number');
  assert.equal(manager.terminateSession(first.session_id), true);
  assert.equal(manager.terminateSession(first.session_id), false);
  await new Promise((resolve) => setTimeout(resolve, 5300));
  assert.equal(fs.existsSync(marker), false, 'cancelled sandbox child continued writing');
});
