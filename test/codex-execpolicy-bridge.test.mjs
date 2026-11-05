import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const binary = fileURLToPath(new URL('../native/bin/' +
  (process.platform === 'win32' ? 'ccm-codex-execpolicy-bridge.exe' :
    'ccm-codex-execpolicy-bridge'), import.meta.url));
const built = fs.existsSync(binary);

function tempRules(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rules-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return path.join(root, 'rules', 'default.rules');
}

function send(...requests) {
  const child = spawnSync(binary, [], {
    input: requests.map((item) => JSON.stringify(item)).join('\n') + '\n',
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

test('native bridge calls the upstream file-locked, idempotent append_allow method', {
  skip: !built && 'Build first with npm run build:native',
}, (t) => {
  const file = tempRules(t);
  const prefix = ['git', 'status'];
  const answer = send(
    { op: 'append_allow', path: file, prefix },
    { op: 'append_allow', path: file, prefix },
    { op: 'check', rules: [file], tokens: ['git', 'status', '--short'] },
  );
  assert.deepEqual(answer.map((x) => x.ok), [true, true, true]);
  assert.equal(answer[2].result.decision, 'allow');
  assert.equal(fs.readFileSync(file, 'utf8'),
    'prefix_rule(pattern=["git", "status"], decision="allow")\n');
});

test('native bridge respects forbidden priority over appended permanent Allow', {
  skip: !built && 'Build first with npm run build:native',
}, (t) => {
  const file = tempRules(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    'prefix_rule(pattern=["git", "push"], decision="forbidden")\n');
  const results = send(
    { op: 'append_allow', path: file, prefix: ['git'] },
    { op: 'check', rules: [file], tokens: ['git', 'push'] },
    { op: 'check', rules: [file], tokens: ['git', 'status'] },
  );
  assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
  assert.equal(results[1].result.decision, 'forbidden');
  assert.equal(results[2].result.decision, 'allow');
});

test('native bridge errors are explicit and never return an Allow on bad rules', {
  skip: !built && 'Build first with npm run build:native',
}, (t) => {
  const file = tempRules(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'prefix_rule(pattern=["git"]\n');
  const response = send(
    { op: 'check', rules: [file], tokens: ['git'] },
    { op: 'append_allow', path: file, prefix: [] },
    { op: 'check', rules: [path.join(path.dirname(file), 'missing.rules')],
      tokens: ['git'] },
  );
  for (const value of response) {
    assert.equal(value.ok, false);
    assert.equal(typeof value.error, 'string');
    assert.ok(value.error.length > 0);
    assert.equal(value.result, undefined);
  }
});
