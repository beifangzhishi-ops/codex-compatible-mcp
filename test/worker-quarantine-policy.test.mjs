import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseWorkerQuarantinePolicy,
  WorkerQuarantinePolicy,
} from '../src/controller/worker-quarantine-policy.mjs';

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for worker quarantine policy reload.');
}

test('worker quarantine policy validates and normalizes error codes', () => {
  assert.deepEqual(
    parseWorkerQuarantinePolicy(JSON.stringify({
      error_codes: [' unknown_method ', 'unknown_method', 'new_contract'],
    })),
    ['unknown_method', 'new_contract'],
  );
  assert.throws(
    () => parseWorkerQuarantinePolicy('{bad json'),
    /Invalid worker quarantine policy JSON/,
  );
  assert.throws(
    () => parseWorkerQuarantinePolicy(JSON.stringify({
      error_codes: ['unknown_method', ''],
    })),
    /non-empty strings/,
  );
});

test('worker quarantine policy hot reload keeps the last known-good config', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-quarantine-policy-'));
  const file = path.join(tempRoot, 'worker-quarantine-errors.json');
  const logs = [];
  let policy = null;
  try {
    await fs.writeFile(
      file,
      JSON.stringify({ error_codes: ['unknown_method'] }),
      'utf8',
    );
    policy = new WorkerQuarantinePolicy({
      file,
      pollIntervalMs: 25,
      log: (level, message) => logs.push({ level, message }),
    });
    policy.start();
    assert.equal(policy.has('unknown_method'), true);

    await fs.writeFile(
      file,
      JSON.stringify({ error_codes: ['new_contract_error'] }),
      'utf8',
    );
    await waitFor(() => policy.has('new_contract_error'));
    assert.equal(policy.has('unknown_method'), false);

    await fs.writeFile(file, '{broken', 'utf8');
    await waitFor(() => logs.some((entry) =>
      entry.level === 'error' && /last known-good/.test(entry.message)));
    assert.equal(policy.has('new_contract_error'), true);

    await fs.writeFile(
      file,
      JSON.stringify({ error_codes: ['recovered_error'] }),
      'utf8',
    );
    await waitFor(() => policy.has('recovered_error'));
    assert.equal(policy.has('new_contract_error'), false);
  } finally {
    policy?.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('worker quarantine policy rejects invalid startup config', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-quarantine-invalid-'));
  const file = path.join(tempRoot, 'worker-quarantine-errors.json');
  try {
    await fs.writeFile(file, JSON.stringify({ error_codes: [42] }), 'utf8');
    assert.throws(
      () => new WorkerQuarantinePolicy({ file }),
      /non-empty strings/,
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
