import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const helper = path.join(root, 'native', 'bin', 'ccm-worker-token-owner.exe');

function run(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: 12_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function ownerSid(dir) {
  const escaped = dir.replaceAll("'", "''");
  return run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Acl -LiteralPath '${escaped}').GetOwner([Security.Principal.SecurityIdentifier]).Value`,
  ]);
}

test('Windows Worker default owner applies to its own, child and Git-created directories', {
  skip: process.platform !== 'win32',
}, () => {
  assert.ok(fs.existsSync(helper), 'Build the native helper first.');
  const cache = path.join(root, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const temp = fs.mkdtempSync(path.join(cache, 'worker-token-owner-'));
  try {
    run(helper, []);
    const direct = path.join(temp, 'worker-created');
    fs.mkdirSync(direct);
    const child = path.join(temp, 'git-like-child-created');
    run(process.execPath, ['-e', 'require("node:fs").mkdirSync(process.argv[1])', child]);
    const repository = path.join(temp, 'repository');
    run('git.exe', ['init', '-q', repository]);
    // Read the effective account SID; do not assume local or Microsoft naming.
    const user = run('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
    const match = user.match(/S-1-5-(?:\d+-)+\d+/);
    assert.ok(match, `Could not find Windows user SID: ${user}`);
    assert.equal(ownerSid(direct), match[0]);
    assert.equal(ownerSid(child), match[0]);
    assert.equal(ownerSid(repository), match[0]);
    assert.equal(ownerSid(path.join(repository, '.git')), match[0]);
    run('git.exe', ['-C', repository, 'status', '--short']);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
