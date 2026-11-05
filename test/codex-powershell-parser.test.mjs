import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CODEX_POWERSHELL_PARSER_PATH,
  parseCodexPowerShellScript,
} from '../src/runtime/sandbox/codex-powershell-parser.mjs';
import { parseShellCommand } from '../src/runtime/sandbox/shell-policy-parser.mjs';
import { ExecPolicyStore } from '../src/controller/exec-policy-store.mjs';

const fixtures = JSON.parse(fs.readFileSync(fileURLToPath(new URL(
  '../native/codex-powershell-parser/src/fixtures/powershell_lowering.json',
  import.meta.url,
)), 'utf8'));
const skipNative = !fs.existsSync(DEFAULT_CODEX_POWERSHELL_PARSER_PATH);

test('upstream Codex PowerShell Tree-sitter lowering fixtures are unchanged', {
  skip: skipNative && 'Build native helpers first: npm run build:native',
}, () => {
  assert.ok(fixtures.length >= 60);
  for (const fixture of fixtures) {
    assert.deepEqual(
      parseCodexPowerShellScript(fixture.script),
      fixture.expected,
      'upstream fixture: ' + fixture.name,
    );
  }
});

test('Codex policy parser rejects PowerShell environment assignments and dynamic arguments', {
  skip: skipNative && 'Build native helpers first: npm run build:native',
}, () => {
  const exe = 'C:\\texlive\\2026\\bin\\windows\\xdvipdfmx.exe';
  assert.equal(parseCodexPowerShellScript(
    `$env:TEXMFHOME='C:\\texmf'; & '${exe}' test.xdv`), null);
  assert.equal(parseCodexPowerShellScript(`& '${exe}' test.xdv`), null);
  assert.equal(parseCodexPowerShellScript('Write-Output $(whoami)'), null);
  assert.equal(parseCodexPowerShellScript('Write-Output "hello $env:TEXMFHOME"'), null);
  assert.deepEqual(parseCodexPowerShellScript('git log -1'), [['git', 'log', '-1']]);
});

test('Codex parser failures cannot fall back to guessable tokens', () => {
  assert.equal(parseCodexPowerShellScript('git status', { exists: () => false }), null);
  assert.equal(parseCodexPowerShellScript('git status', {
    exists: () => true,
    spawn: () => ({ status: 0, stdout: 'not json' }),
  }), null);
  assert.equal(parseCodexPowerShellScript('git status', {
    exists: () => true,
    spawn: () => ({ status: 1, stderr: 'failure' }),
  }), null);
  assert.equal(parseCodexPowerShellScript('git status', {
    exists: () => true,
    spawn: () => ({ status: 0, stdout: '{"commands":[["git"],[]]}' }),
  }), null);
});

test('a single saved exe prefix does not authorize any preceding PowerShell assignment', {
  skip: skipNative && 'Build native helpers first: npm run build:native',
}, () => {
  const exe = 'C:\\texlive\\2026\\bin\\windows\\xdvipdfmx.exe';
  const store = new ExecPolicyStore();
  store.allow({ prefixTokens: [exe] });
  const environment = { platform: 'windows', shell: { path: 'powershell.exe' } };
  const args = (cmd) => ({ cmd, shell: 'powershell.exe' });
  assert.equal(store.match({ environment, args: args(
    `$env:TEXMFHOME='C:\\texmf'; & '${exe}' output.xdv`),
  }), null);
  assert.equal(store.match({ environment, args: args(
    `& '${exe}' output.xdv`),
  }), null);
  assert.equal(parseShellCommand('git status | git log -1')?.segments.length, 2);
});

test('upstream allows a piped command only when every parsed segment is explicitly allowed', {
  skip: skipNative && 'Build native helpers first: npm run build:native',
}, () => {
  const store = new ExecPolicyStore();
  const environment = { platform: 'windows', shell: { path: 'powershell.exe' } };
  store.allow({ prefixTokens: ['Write-Output'] });
  const args = { cmd: 'Write-Output hello | Measure-Object', shell: 'powershell.exe' };
  assert.equal(store.match({ environment, args }), null);
  store.allow({ prefixTokens: ['Measure-Object'] });
  assert.equal(store.match({ environment, args })?.decision, 'allow');
});
