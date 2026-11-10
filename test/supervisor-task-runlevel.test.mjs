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
