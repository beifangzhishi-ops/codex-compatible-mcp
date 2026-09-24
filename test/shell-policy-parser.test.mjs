import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalShell,
  parseShellCommand,
  tokenPrefixMatches,
} from '../src/runtime/sandbox/shell-policy-parser.mjs';
import {
  isTrustedNodeTestCommand,
} from '../src/runtime/sandbox/node-test-policy.mjs';

test('PowerShell parser keeps quoted WSL bash syntax inside one outer segment', () => {
  const parsed = parseShellCommand(
    `wsl.exe -d PhD-CFD -- bash -lc 'find /tmp -type f | sort; sed -n "1,2p" /etc/profile'`,
    { shell: 'powershell.exe' },
  );
  assert.equal(parsed?.segments.length, 1);
  assert.deepEqual(parsed?.segments[0].tokens.slice(0, 6), [
    'wsl.exe',
    '-d',
    'PhD-CFD',
    '--',
    'bash',
    '-lc',
  ]);
  assert.match(parsed?.segments[0].tokens[6], /find .*\| sort; sed/);
});

test('PowerShell parser preserves doubled single-quote literals', () => {
  const parsed = parseShellCommand(
    "Write-Output 'it''s;still-one-argument'",
    { shell: 'powershell.exe' },
  );
  assert.equal(parsed?.segments.length, 1);
  assert.deepEqual(parsed?.segments[0].tokens, [
    'Write-Output',
    "it's;still-one-argument",
  ]);
});

test('PowerShell parser splits real executable boundaries outside quotes', () => {
  const parsed = parseShellCommand(
    'git push origin main && node --test test/a.test.mjs; wsl.exe --status',
    { shell: 'powershell.exe' },
  );
  assert.deepEqual(
    parsed?.segments.map((segment) => segment.tokens[0]),
    ['git', 'node', 'wsl.exe'],
  );
  assert.deepEqual(parsed?.operators, ['&&', ';']);
});

test('PowerShell parser fails closed on unsupported execution syntax', () => {
  for (const command of [
    '& git push origin main',
    'Write-Output $(whoami)',
    'Write-Output "$(whoami)"',
    'git push origin main > out.txt',
    '{ git push origin main }',
  ]) {
    assert.equal(parseShellCommand(command, { shell: 'powershell.exe' }), null);
  }
});

test('cmd parser respects caret-escaped metacharacters', () => {
  const parsed = parseShellCommand('echo a ^& b && node --test', { shell: 'cmd.exe' });
  assert.equal(parsed?.segments.length, 2);
  assert.deepEqual(parsed?.segments[1].tokens, ['node', '--test']);
});

test('cmd parser keeps caret literal inside double quotes', () => {
  const parsed = parseShellCommand('echo "a^b"', { shell: 'cmd.exe' });
  assert.deepEqual(parsed?.segments[0].tokens, ['echo', 'a^b']);
});

test('cmd parser does not treat single quotes as quoting syntax', () => {
  const parsed = parseShellCommand("echo 'a & whoami'", { shell: 'cmd.exe' });
  assert.equal(parsed?.segments.length, 2);
  assert.deepEqual(parsed?.segments[1].tokens, ["whoami'"]);
});

test('token prefix matching is ordered and does not trust lookalike paths', () => {
  assert.equal(
    tokenPrefixMatches(['wsl.exe'], ['wsl', '--status'], { platform: 'windows' }),
    true,
  );
  assert.equal(
    tokenPrefixMatches(['wsl.exe'], ['.\\wsl.exe', '--status'], { platform: 'windows' }),
    false,
  );
  assert.equal(
    tokenPrefixMatches(
      ['C:\\Tools\\WSL.EXE'],
      ['c:\\tools\\wsl.exe', '--status'],
      { platform: 'windows' },
    ),
    true,
  );
  assert.equal(
    tokenPrefixMatches(
      ['git', 'config', '--get'],
      ['git', 'config', '--get', 'user.name'],
      { platform: 'windows' },
    ),
    true,
  );
  assert.equal(
    tokenPrefixMatches(
      ['git', 'config', '--get'],
      ['git', 'config', '--global', '--get', 'user.name'],
      { platform: 'windows' },
    ),
    false,
  );
});

test('shell normalization handles remote Windows paths independent of controller OS', () => {
  assert.equal(
    canonicalShell('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    'powershell',
  );
  assert.equal(canonicalShell('C:/Program Files/PowerShell/7/pwsh.exe'), 'pwsh');
});

test('node test trust matches only direct node --test segments', () => {
  assert.equal(
    isTrustedNodeTestCommand('node --test test/a.test.mjs', {
      shell: 'powershell.exe',
      platform: 'windows',
    }),
    true,
  );
  assert.equal(
    isTrustedNodeTestCommand('node script.js --test', {
      shell: 'powershell.exe',
      platform: 'windows',
    }),
    false,
  );
  assert.equal(
    isTrustedNodeTestCommand('node --inspect --test', {
      shell: 'powershell.exe',
      platform: 'windows',
    }),
    false,
  );
  assert.equal(
    isTrustedNodeTestCommand('node --test', {
      shell: 'powershell.exe',
      platform: 'linux',
    }),
    false,
  );
});

