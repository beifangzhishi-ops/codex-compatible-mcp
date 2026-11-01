import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createBoundedShutdown } from '../src/worker/bounded-shutdown.mjs';

test('停止清理挂起时仍会退出，重复停止不重复清理', async () => {
  const exits = [];
  let calls = 0;
  const shutdown = createBoundedShutdown({
    cleanup: () => { calls++; return new Promise(() => {}); },
    exit: (code) => exits.push(code), timeoutMs: 10, log: () => {},
  });
  assert.equal(shutdown(), shutdown());
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.deepEqual(exits, [1]);
});

test('真实进程有残留活动句柄时，完成清理后仍退出', async () => {
  const moduleUrl = new URL('../src/worker/bounded-shutdown.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { createBoundedShutdown } from ${JSON.stringify(moduleUrl)};
    setInterval(() => {}, 1000);
    await createBoundedShutdown({ cleanup: async () => {} })();`], { windowsHide: true });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: 0, signal: null });
  } finally { clearTimeout(timer); }
});
