import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkerTokenOwner } from '../src/worker/token-owner.mjs';

test('non-Windows Worker skips token owner initialization', () => {
  normalizeWorkerTokenOwner({
    platform: 'linux',
    existsSync: () => { throw new Error('unexpected check'); },
  });
});

test('Windows Worker runs native helper before processing requests', () => {
  const calls = [];
  normalizeWorkerTokenOwner({
    platform: 'win32',
    helperPath: 'C:/ccm/token.exe',
    existsSync: () => true,
    spawn: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:/ccm/token.exe');
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.windowsHide, true);
});

test('Windows Worker fails startup if token initialization fails', () => {
  assert.throws(
    () => normalizeWorkerTokenOwner({
      platform: 'win32',
      helperPath: 'C:/ccm/token.exe',
      existsSync: () => true,
      spawn: () => ({ status: 1, stderr: 'Access denied' }),
    }),
    /Access denied/,
  );
  assert.throws(
    () => normalizeWorkerTokenOwner({
      platform: 'win32',
      helperPath: 'C:/ccm/token.exe',
      existsSync: () => false,
    }),
    /helper is missing/,
  );
});
