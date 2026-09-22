import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime/index.mjs';
import { killChildProcessTree } from '../src/runtime/executors/native-executor.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const stateDir = path.join(root, '.state');

function runtimeFor(permissionProfile = 'workspace-write') {
  return createRuntime({
    environment: {
      id: 'test-local',
      cwd: root,
      permissionProfile,
    },
  });
}

test('exec_command preserves a nonzero exit code', async () => {
  const runtime = runtimeFor();
  try {
    const result = await runtime.processManager.execCommand({
      cmd: 'Write-Output CCM_TEST_OK; exit 7',
    });
    assert.equal(result.exit_code, 7);
    assert.match(result.output, /CCM_TEST_OK/);
  } finally {
    runtime.close();
  }
});
test('workspace-write can write inside the workspace', async () => {
  fs.mkdirSync(stateDir, { recursive: true });
  const target = path.join(stateDir, 'workspace-write-test.txt');
  fs.rmSync(target, { force: true });
  const runtime = runtimeFor('workspace-write');
  try {
    const result = await runtime.processManager.execCommand({
      cmd: "Set-Content -LiteralPath '.state/workspace-write-test.txt' -Value ok; Get-Content -LiteralPath '.state/workspace-write-test.txt'",
    });
    assert.equal(result.exit_code, 0);
    assert.match(result.output, /ok/);
    assert.equal(fs.existsSync(target), true);
  } finally {
    runtime.close();
    fs.rmSync(target, { force: true });
  }
});

test('workspace-write can reuse an existing sandbox workspace ACL', async () => {
  const runtime = runtimeFor('workspace-write');
  try {
    const first = await runtime.processManager.execCommand({
      cmd: 'Write-Output first',
      yield_time_ms: 5000,
    });
    assert.equal(first.exit_code, 0);
    assert.match(first.output, /first/);

    const second = await runtime.processManager.execCommand({
      cmd: 'Write-Output second',
      yield_time_ms: 5000,
    });
    assert.equal(second.exit_code, 0);
    assert.match(second.output, /second/);
  } finally {
    runtime.close();
  }
});

test('read-only blocks writes inside the workspace', async () => {
  fs.mkdirSync(stateDir, { recursive: true });
  const target = path.join(stateDir, 'read-only-test.txt');
  fs.rmSync(target, { force: true });
  const runtime = runtimeFor('read-only');
  try {
    const result = await runtime.processManager.execCommand({
      cmd: "Set-Content -LiteralPath '.state/read-only-test.txt' -Value blocked -ErrorAction Stop",
    });
    assert.notEqual(result.exit_code, 0);
    assert.equal(fs.existsSync(target), false);
  } finally {
    runtime.close();
    fs.rmSync(target, { force: true });
  }
});
test('long commands yield an integer session id and resume with write_stdin', async () => {
  const runtime = runtimeFor();
  try {
    const startedAt = Date.now();
    const first = await runtime.processManager.execCommand({
      cmd: 'Write-Output before; Start-Sleep -Seconds 3; Write-Output after',
      yield_time_ms: 250,
    });
    assert.equal(typeof first.session_id, 'number');
    assert.ok(Date.now() - startedAt < 2500, 'Windows initial yield should stay short');

    const second = await runtime.processManager.writeStdin({
      session_id: first.session_id,
      chars: '',
      yield_time_ms: 5000,
    });
    assert.equal(second.exit_code, 0);
    assert.match(first.output + second.output, /before/);
    assert.match(first.output + second.output, /after/);
  } finally {
    runtime.close();
  }
});

test('initial exec wait is capped even when callers request 30 seconds', async () => {
  const runtime = runtimeFor();
  try {
    const startedAt = Date.now();
    const first = await runtime.processManager.execCommand({
      cmd: 'Start-Sleep -Seconds 6; Write-Output capped',
      yield_time_ms: 30_000,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(typeof first.session_id, 'number');
    assert.ok(
      elapsed >= 4_000 && elapsed < 5_800,
      'initial exec should cap the requested 30 second wait at about 5 seconds',
    );

    const second = await runtime.processManager.writeStdin({
      session_id: first.session_id,
      chars: '',
      yield_time_ms: 5_000,
    });
    assert.equal(second.exit_code, 0);
    assert.match(first.output + second.output, /capped/);
  } finally {
    runtime.close();
  }
});

test('empty write_stdin polling returns promptly by default', async () => {
  const runtime = runtimeFor();
  try {
    const first = await runtime.processManager.execCommand({
      cmd: 'Start-Sleep -Seconds 5',
      yield_time_ms: 250,
    });
    assert.equal(typeof first.session_id, 'number');

    const startedAt = Date.now();
    const second = await runtime.processManager.writeStdin({
      session_id: first.session_id,
      chars: '',
    });
    assert.equal(typeof second.session_id, 'number');
    assert.ok(Date.now() - startedAt < 2500, 'empty polling should default to about 1 second');
  } finally {
    runtime.close();
  }
});

test('tty mode runs through the same native sandbox path', async () => {
  const runtime = runtimeFor();
  try {
    const result = await runtime.processManager.execCommand({
      cmd: 'Write-Output TTY_OK',
      tty: true,
    });
    assert.equal(result.exit_code, 0);
    assert.match(result.output, /TTY_OK/);
  } finally {
    runtime.close();
  }
});


test('tty sessions accept interactive write_stdin input', async () => {
  const runtime = runtimeFor();
  try {
    const first = await runtime.processManager.execCommand({
      cmd: 'echo TTY_READY & set /p LINE= & echo TTY_DONE',
      shell: 'cmd.exe',
      tty: true,
      yield_time_ms: 250,
    });
    assert.equal(typeof first.session_id, 'number');
    assert.match(first.output, /TTY_READY/);

    const second = await runtime.processManager.writeStdin({
      session_id: first.session_id,
      chars: 'hello\n',
      yield_time_ms: 5000,
    });
    assert.equal(second.exit_code, 0);
    assert.match(second.output, /TTY_DONE/);
  } finally {
    runtime.close();
  }
});

test('Windows child termination uses taskkill /T /F before falling back to direct kill', () => {
  const calls = [];
  let directKillCount = 0;
  const child = {
    pid: 4321,
    kill() {
      directKillCount += 1;
    },
  };

  killChildProcessTree(child, {
    platform: 'win32',
    spawnSync(file, args, options) {
      calls.push({ file, args, options });
      return { status: 0 };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'taskkill.exe');
  assert.deepEqual(calls[0].args, ['/PID', '4321', '/T', '/F']);
  assert.equal(directKillCount, 0);
});

test('child termination falls back to direct kill when taskkill fails', () => {
  let directKillCount = 0;
  const child = {
    pid: 4321,
    kill() {
      directKillCount += 1;
    },
  };

  killChildProcessTree(child, {
    platform: 'win32',
    spawnSync() {
      return { status: 1 };
    },
  });

  assert.equal(directKillCount, 1);
});
