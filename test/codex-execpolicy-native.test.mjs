import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The core policy parser, decision model, and checker are the unmodified Rust
// sources from openai/codex @ ed8eac40832e6a79f30eaeb3c521912f231d43eb.
const executable = fileURLToPath(new URL('../native/bin/' +
  (process.platform === 'win32' ? 'ccm-codex-execpolicy.exe' :
    'ccm-codex-execpolicy'), import.meta.url));
const nativeAvailable = fs.existsSync(executable);

function policyFiles(t, texts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-codex-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return texts.map((text, i) => {
    const p = path.join(dir, i + '.rules');
    fs.writeFileSync(p, text, 'utf8');
    return p;
  });
}

function check(rules, command, { resolveHostExecutables = false } = {}) {
  const args = ['check', ...rules.flatMap((rule) => ['--rules', rule]),
    ...(resolveHostExecutables ? ['--resolve-host-executables'] : []),
    ...command];
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    output: result.status === 0 ? JSON.parse(result.stdout) : null,
    stderr: result.stderr,
  };
}

test('native Codex Starlark parser supports prefix alternatives, allow and examples', {
  skip: !nativeAvailable && 'Build first with npm run build:native',
}, (t) => {
  const files = policyFiles(t, [`
prefix_rule(
    pattern = ["git", ["status", "log"]],
    decision = "allow",
    justification = "Read-only VCS history",
    match = ["git status", "git log -1"],
    not_match = ["git push"],
)
`]);
  const status = check(files, ['git', 'status', '--short']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.output.decision, 'allow');
  assert.equal(status.output.matchedRules.length, 1);
  assert.deepEqual(status.output.matchedRules[0].prefixRuleMatch.matchedPrefix,
    ['git', 'status']);
  assert.equal(check(files, ['git', 'push']).output.decision, undefined);
});

test('native Codex picks the strictest matching rule across files', {
  skip: !nativeAvailable && 'Build first with npm run build:native',
}, (t) => {
  const files = policyFiles(t, [
    'prefix_rule(pattern=["git"], decision="allow")',
    'prefix_rule(pattern=["git", "push"], decision="prompt")',
    'prefix_rule(pattern=["git", "push", "--force"], decision="forbidden")',
  ]);
  assert.equal(check(files, ['git', 'status']).output.decision, 'allow');
  assert.equal(check(files, ['git', 'push']).output.decision, 'prompt');
  const forced = check(files, ['git', 'push', '--force']);
  assert.equal(forced.output.decision, 'forbidden');
  assert.equal(forced.output.matchedRules.length, 3);
});

test('native Codex validates positive and negative examples during file load', {
  skip: !nativeAvailable && 'Build first with npm run build:native',
}, (t) => {
  const invalid = policyFiles(t, [`
prefix_rule(pattern=["git", "status"],
    match=["git push"], not_match=["git status"])
`]);
  const r = check(invalid, ['git', 'status']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /example|match|rule/i);
});

test('native Codex preserves case-sensitive matching unless canonical_matching is set', {
  skip: !nativeAvailable && 'Build first with npm run build:native',
}, (t) => {
  const files = policyFiles(t, [`
prefix_rule(pattern=["Git", "STATUS"], decision="prompt")
prefix_rule(pattern=["café", "RUN"], canonical_matching=True, decision="allow")
`]);
  assert.equal(check(files, ['git', 'STATUS']).output.decision, undefined);
  assert.equal(check(files, ['Git', 'STATUS']).output.decision, 'prompt');
  assert.equal(check(files, ['CAFE\u0301', 'run']).output.decision, 'allow');
});

test('native Codex rejects unsupported Starlark calls and does not produce an allow', {
  skip: !nativeAvailable && 'Build first with npm run build:native',
}, (t) => {
  const files = policyFiles(t, ['arbitrary_code("run")']);
  const r = check(files, ['git', 'status']);
  assert.notEqual(r.code, 0);
  assert.equal(r.output, null);
});

test('native Codex executable path fallback is opt-in, and constrained by host_executable', {
  skip: !nativeAvailable && 'Build first with npm run build:native',
}, (t) => {
  const absolute = process.platform === 'win32'
    ? 'C:\\tools\\git.exe' : '/opt/bin/git';
  const denied = process.platform === 'win32'
    ? 'C:\\other\\git.exe' : '/other/git';
  // Codex's host-executable resolution normalizes Windows .exe suffixes
  // to the bare lookup key before attempting basename rules.
  const executableName = 'git';
  const files = policyFiles(t, [`
prefix_rule(pattern=[${JSON.stringify(executableName)}, "status"], decision="allow")
host_executable(name=${JSON.stringify(executableName)}, paths=[${JSON.stringify(absolute)}])
`]);
  assert.equal(check(files, [absolute, 'status']).output.decision, undefined);
  assert.equal(check(files, [absolute, 'status'], {
    resolveHostExecutables: true,
  }).output.decision, 'allow');
  assert.equal(check(files, [denied, 'status'], {
    resolveHostExecutables: true,
  }).output.decision, undefined);
});
