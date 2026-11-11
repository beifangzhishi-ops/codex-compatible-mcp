import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CodexExecPolicy,
  DEFAULT_POLICY_BINARY,
  DEFAULT_RULES_FILE,
} from '../src/controller/codex-execpolicy.mjs';
import { parseShellCommand } from '../src/runtime/sandbox/shell-policy-parser.mjs';

const built = fs.existsSync(DEFAULT_POLICY_BINARY);

function tempPolicy(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-codex-rules-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'default.rules');
}

test('native policy is the only command authorization engine', {
  skip: !built && 'build native policy bridge first',
}, (t) => {
  const stateFile = tempPolicy(t);
  const native = new CodexExecPolicy({ stateFile });
  assert.equal(native.matchSegment({ tokens: ['git', 'push'] }), null);
  const saved = native.allow({ prefixTokens: ['git', 'status'] });
  assert.equal(saved.decision, 'allow');
  assert.equal(saved.prefix_tokens[0], 'git');
  assert.equal(native.matchSegment({ tokens: ['git', 'status', '--short'] }).decision, 'allow');
  assert.equal(native.matchSegment({ tokens: ['git', 'push'] }), null);
  assert.equal(native.allow({ prefixTokens: ['git', 'status'] }).decision, 'allow');
  assert.equal(fs.readFileSync(stateFile, 'utf8').trim().split(/\r?\n/).length, 1);
  const compound = { shell: 'powershell', segments: [
    { tokens: ['git', 'status'] }, { tokens: ['git', 'status', '--short'] },
  ] };
  assert.equal(native.match({ parsed: compound }).decision, 'allow');
  assert.equal(native.match({ parsed: { segments: [
    { tokens: ['git', 'status'] }, { tokens: ['git', 'push'] },
  ] } }), null);
});

test('native policy Forbidden dominates Allow, Prompt requests approval, ambiguous syntax is not trusted', {
  skip: !built && 'build native policy bridge first',
}, (t) => {
  const stateFile = tempPolicy(t);
  fs.writeFileSync(stateFile, [
    'prefix_rule(pattern=["git"], decision="allow")',
    'prefix_rule(pattern=["git", "push"], decision="forbidden")',
    'prefix_rule(pattern=["danger"], decision="prompt")',
    '',
  ].join('\n'));
  const native = new CodexExecPolicy({ stateFile });
  assert.equal(native.matchSegment({ tokens: ['git', 'push'] }).decision, 'forbidden');
  assert.equal(native.matchSegment({ tokens: ['git', 'status'] }).decision, 'allow');
  assert.equal(native.matchSegment({ tokens: ['danger', 'test'] }).decision, 'prompt');
  assert.equal(native.match({ parsed: { segments: [
    { tokens: ['git', 'status'] }, { tokens: ['git', 'push'] },
  ] } }).decision, 'forbidden');
  assert.equal(native.match({ parsed: parseShellCommand('git status | Invoke-Expression $x') }), null);
});

test('native policy rejects invalid Starlark rather than granting execution', {
  skip: !built && 'build native policy bridge first',
}, (t) => {
  const stateFile = tempPolicy(t);
  fs.writeFileSync(stateFile, 'prefix_rule(pattern=["git"]\n');
  const native = new CodexExecPolicy({ stateFile });
  assert.throws(() => native.matchSegment({ tokens: ['git', 'status'] }), /Native Codex ExecPolicy/);
});

test('the migrated 6v Controller policy preserves saved and preauthorized commands', {
  skip: !built || !fs.existsSync(DEFAULT_RULES_FILE) ? '6v Controller policy file is not present' : false,
}, () => {
  const native = new CodexExecPolicy();
  const allowed = [
    ['git', 'status', '--short'],
    ['git', 'clone', 'https://example.invalid/repo.git'],
    ['git', 'fetch', '--all', '--prune'],
    ['git', 'pull', '--ff-only'],
    ['git', 'push', 'origin', 'main'],
    ['git', 'ls-remote', 'origin', 'HEAD'],
    ['node', '--test', 'test/approval.test.mjs'],
    ['npm', 'run', 'build:native'],
    ['C:\\Program Files\\Tailscale\\tailscale.exe', 'version'],
    ['C:\\texlive\\2026\\bin\\windows\\xdvipdfmx.exe', '--version'],
    ['C:\\texlive\\2026\\bin\\windows\\xelatex.exe', '--version'],
    ['wsl.exe', '--status'],
  ];
  for (const tokens of allowed) {
    assert.equal(native.matchSegment({ tokens })?.decision, 'allow', tokens.join(' '));
  }
  for (const tokens of [
    ['git', 'status'],
    ['git', 'submodule', 'update', '--init'],
    ['node', '-e', 'process.exit(0)'],
    ['npm', 'install'],
    ['npm', 'run', 'build'],
    ['tailscale.exe', 'status'],
    ['xelatex', '--version'],
  ]) {
    assert.equal(native.matchSegment({ tokens }), null, tokens.join(' '));
  }
  assert.equal(fs.readFileSync(DEFAULT_RULES_FILE, 'utf8').trim().split(/\r?\n/).length, 14);
});
