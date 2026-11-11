import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CODEX_POWERSHELL_PARSER_PATH,
  parseCodexPowerShellScript,
} from '../src/runtime/sandbox/codex-powershell-parser.mjs';
import { parseShellCommand } from '../src/runtime/sandbox/shell-policy-parser.mjs';
import { CodexExecPolicy } from '../src/controller/codex-execpolicy.mjs';

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

test('native Codex policy matches a pinned executable through validated literal wrappers', {
  skip: skipNative && 'Build native helpers first: npm run build:native',
}, (t) => {
  const exe = 'C:\\texlive\\2026\\bin\\windows\\xdvipdfmx.exe';
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-codex-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policy = new CodexExecPolicy({ stateFile: path.join(directory, 'default.rules') });
  policy.allow({ prefixTokens: [exe] });
  const envCommand = "$env:TEXMFHOME='C:\\texmf'; & '" + exe + "' output.xdv";
  const callCommand = "& '" + exe + "' output.xdv";
  const dynamicCommand = "$env:TEXMFHOME=$dynamic; & '" + exe + "' output.xdv";
  const parsed = (cmd) => parseShellCommand(cmd, { shell: 'powershell.exe' });
  assert.equal(policy.match({ parsed: parsed(envCommand) })?.decision, 'allow');
  assert.equal(policy.match({ parsed: parsed(callCommand) })?.decision, 'allow');
  assert.equal(policy.match({ parsed: parsed(dynamicCommand) }), null);
  assert.equal(parseShellCommand('git status | git log -1')?.segments.length, 2);
});

test('native Codex policy requires an Allow for every piped command segment', {
  skip: skipNative && 'Build native helpers first: npm run build:native',
}, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-codex-policy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const policy = new CodexExecPolicy({ stateFile: path.join(directory, 'default.rules') });
  const parsed = parseShellCommand('Write-Output hello | Measure-Object', { shell: 'powershell.exe' });
  policy.allow({ prefixTokens: ['Write-Output'] });
  assert.equal(policy.match({ parsed }), null);
  policy.allow({ prefixTokens: ['Measure-Object'] });
  assert.equal(policy.match({ parsed })?.decision, 'allow');
});
