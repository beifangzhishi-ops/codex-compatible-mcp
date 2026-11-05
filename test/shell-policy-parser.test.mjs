import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalShell,
  parseShellCommand,
  tokenPrefixMatches,
} from '../src/runtime/sandbox/shell-policy-parser.mjs';

test('Codex PowerShell parser keeps complex WSL bash syntax opaque rather than guessing at argv', () => {
  const parsed = parseShellCommand(
    `wsl.exe -d PhD-CFD -- bash -lc 'find /tmp -type f | sort; sed -n "1,2p" /etc/profile'`,
    { shell: 'powershell.exe' },
  );
  assert.equal(parsed, null);
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
    '& $program status',
    '& (Get-Command tailscale.exe) status',
    'Write-Output okay; & tailscale.exe status',
    "& 'C:\\Program Files\\Tailscale\\tailscale.exe'$(whoami)",
    'Write-Output $(whoami)',
    'Write-Output "$(whoami)"',
    'git push origin main > out.txt',
    '{ git push origin main }',
  ]) {
    assert.equal(parseShellCommand(command, { shell: 'powershell.exe' }), null);
  }
});

test('Codex keeps PowerShell invocation operators opaque even with absolute literal paths', () => {
  const fullPath = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  assert.equal(parseShellCommand(`& '${fullPath}' status`, { shell: 'powershell.exe' }), null);
  assert.equal(parseShellCommand(`& "${fullPath}" status`, { shell: 'powershell.exe' }), null);
  assert.equal(parseShellCommand(`Write-Output okay; & '${fullPath}' status`,
    { shell: 'pwsh.exe' }), null);
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

test('Codex saved prefix matching compares tokens exactly, including casing and exe suffixes', () => {
  assert.equal(
    tokenPrefixMatches(['wsl.exe'], ['wsl', '--status']),
    false,
  );
  assert.equal(
    tokenPrefixMatches(['wsl.exe'], ['.\\wsl.exe', '--status']),
    false,
  );
  assert.equal(
    tokenPrefixMatches(
      ['C:\\Tools\\WSL.EXE'],
      ['c:\\tools\\wsl.exe', '--status'],
    ),
    false,
  );
  assert.equal(
    tokenPrefixMatches(
      ['git', 'config', '--get'],
      ['git', 'config', '--get', 'user.name'],
    ),
    true,
  );
  assert.equal(
    tokenPrefixMatches(
      ['git', 'config', '--get'],
      ['git', 'config', '--global', '--get', 'user.name'],
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

