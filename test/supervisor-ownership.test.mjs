import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { supervisorOwnsProcess } from '../src/worker/supervisor-ownership.mjs';

test('supervisor ownership is limited to the PID in its existing state file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-supervisor-ownership-'));
  const file = path.join(dir, 'ccm-worker.pid');
  try {
    assert.equal(supervisorOwnsProcess(file, 123), false);
    await fs.writeFile(file, '123\r\n');
    assert.equal(supervisorOwnsProcess(file, 123), true);
    assert.equal(supervisorOwnsProcess(file, 124), false);
    await fs.writeFile(file, '123; whoami');
    assert.equal(supervisorOwnsProcess(file, 123), false);
    await fs.writeFile(file, 'not-a-pid');
    assert.equal(supervisorOwnsProcess(file, 123), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
