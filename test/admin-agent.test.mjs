import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAdministratorServer } from '../src/admin/agent.mjs';
import { AdministratorProcessClient } from '../src/runtime/admin/admin-process-client.mjs';
import { ADMIN_LOOPBACK_HOST, validateAdminEndpoint } from '../src/runtime/admin/ipc-protocol.mjs';

test('local administrator agent authenticates, streams output, accepts stdin, and hides Worker secrets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-admin-ipc-'));
  const keyFile = path.join(root, 'agent.key');
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, key);
  const server = createAdministratorServer({ key });
  let endpoint;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, ADMIN_LOOPBACK_HOST, resolve);
    });
    endpoint = { host: ADMIN_LOOPBACK_HOST, port: server.address().port };
    const client = new AdministratorProcessClient({ keyFile, endpoint });
    const run = (contents, tokenFile = keyFile) => new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('administrator IPC test timed out')), 10_000);
      const child = new AdministratorProcessClient({ keyFile: tokenFile, endpoint }).startProcess({
        file: process.execPath,
        args: ['-e', contents],
        cwd: root,
        env: { ...process.env, CCM_AGENT_SECRET_PROBE: 'must-not-leak', ADMIN_AGENT_PROBE: 'present' },
        onData: (chunk) => { output += String(chunk); },
        onExit: (code) => { clearTimeout(timer); resolve({ code, output }); },
      });
      child.write('from-stdin\n');
    });
    const success = await run(`
      process.stdin.once('data', (chunk) => {
        process.stdout.write('stdout:' + chunk.toString());
        process.stderr.write('stderr:' + process.env.ADMIN_AGENT_PROBE + '/' + process.env.CCM_AGENT_SECRET_PROBE);
        process.exit(0);
      });
    `);
    assert.equal(success.code, 0, success.output);
    assert.match(success.output, /stdout:from-stdin/);
    assert.match(success.output, /stderr:present\/undefined/);
    assert.doesNotMatch(success.output, /must-not-leak/);

    const wrongKeyFile = path.join(root, 'wrong.key');
    fs.writeFileSync(wrongKeyFile, crypto.randomBytes(32).toString('hex'));
    const denied = await run('console.log("must-never-start")', wrongKeyFile);
    assert.equal(denied.code, 125);
    assert.match(denied.output, /authentication failed/i);
    assert.doesNotMatch(denied.output, /must-never-start/);
    assert.deepEqual(client.endpoint, endpoint);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('administrator IPC accepts loopback endpoints only', () => {
  assert.deepEqual(validateAdminEndpoint({ host: '127.0.0.1', port: 40001 }),
    { host: '127.0.0.1', port: 40001 });
  for (const invalid of [
    { host: '0.0.0.0', port: 40001 }, { host: '192.168.1.10', port: 40001 },
    { host: 'localhost', port: 40001 }, { host: '127.0.0.1', port: 0 },
  ]) {
    assert.throws(() => validateAdminEndpoint(invalid), /Invalid CCM/);
  }
});

test('uninstalled administrator agent fails without fallback to ordinary privileges', () => {
  const client = new AdministratorProcessClient({ keyFile: path.join(os.tmpdir(), crypto.randomUUID()) });
  assert.throws(() => client.startProcess({}), /not installed/);
});
