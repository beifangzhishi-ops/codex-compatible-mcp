import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

for (const installer of [
  'install-ccm-autostart.ps1',
  'install-ccm-worker-autostart.ps1',
]) {
  test(`${installer} installs a normal-user scheduled task`, async () => {
    const script = await fs.readFile(new URL(`../scripts/${installer}`, import.meta.url), 'utf8');
    assert.match(script, /New-ScheduledTaskPrincipal[^\r\n]*-RunLevel Limited/);
    assert.doesNotMatch(script, /-RunLevel Highest/);
  });
}

test('only the administrator agent is scheduled with Highest privilege', async () => {
  const script = await fs.readFile(new URL('../scripts/install-ccm-admin-agent.ps1', import.meta.url), 'utf8');
  assert.match(script, /New-ScheduledTaskPrincipal[^\r\n]*-RunLevel Highest/);
  assert.match(script, /Register-ScheduledTask -TaskName 'CCM Administrator Agent'/);
});

test('privilege migration independently schedules a fully-qualified elevated switch task', async () => {
  const finish = await fs.readFile(new URL('../scripts/complete-ccm-privilege-split.ps1', import.meta.url), 'utf8');
  const worker = await fs.readFile(new URL('../scripts/install-ccm-worker-autostart.ps1', import.meta.url), 'utf8');
  const switchScript = await fs.readFile(new URL('../scripts/switch-ccm-task-to-normal.ps1', import.meta.url), 'utf8');
  assert.match(finish, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(finish, /Register-ScheduledTask[^\r\n]*-ErrorAction Stop/);
  assert.match(finish, /Start-ScheduledTask[^\r\n]*-ErrorAction Stop/);
  assert.match(worker, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(switchScript, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(switchScript, /confirmed \$taskName stopped before Limited restart/);
  assert.match(switchScript, /\$current.State -ne 'Running'/);
});

test('Controller Supervisor waits on the prior instance mutex during privilege migration', async () => {
  const script = await fs.readFile(new URL('../scripts/ccm-supervisor.ps1', import.meta.url), 'utf8');
  assert.match(script, /\$mutex\.WaitOne\(60000\)/);
  assert.match(script, /bootstrap error: CCM native build failed|bootstrap error: \$\(\$_\.Exception\.Message\)/);
  const installer = await fs.readFile(new URL('../scripts/install-ccm-autostart.ps1', import.meta.url), 'utf8');
  assert.match(installer, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
});
