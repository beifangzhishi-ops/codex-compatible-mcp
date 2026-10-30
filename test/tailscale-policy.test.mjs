import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAILSCALE_EXE,
  trustedTailscaleInvocation,
} from '../src/runtime/sandbox/tailscale-policy.mjs';

const environment = {
  platform: 'windows',
  shell: { path: 'powershell.exe' },
};

test('Tailscale trust binds aliases and quoted PowerShell paths to one absolute executable', () => {
  for (const command of [
    'tailscale status',
    'tailscale.exe status',
    `& '${TAILSCALE_EXE}' status`,
    `& "${TAILSCALE_EXE}" status`,
    `"${TAILSCALE_EXE}" status`,
  ]) {
    assert.deepEqual(trustedTailscaleInvocation(command, null, environment), {
      cmd: `& '${TAILSCALE_EXE}' status`,
    });
  }
  assert.deepEqual(
    trustedTailscaleInvocation('tailscale version', 'pwsh.exe', environment),
    { cmd: `& '${TAILSCALE_EXE}' version` },
  );
});

test('CMD Tailscale calls safely invoke the pinned path via PowerShell', () => {
  for (const command of [
    'tailscale version',
    'tailscale.exe version',
    `"${TAILSCALE_EXE}" version`,
    `""${TAILSCALE_EXE}" version"`,
  ]) {
    assert.deepEqual(
      trustedTailscaleInvocation(command, 'cmd.exe', environment),
      { cmd: `& '${TAILSCALE_EXE}' version`, shell: 'powershell.exe' },
    );
  }
});

test('Tailscale trust does not elevate lookalikes, additional commands or dynamic calls', () => {
  const badCommands = [
    '.\\tailscale.exe version',
    'C:\\temp\\tailscale.exe version',
    'tailscale2.exe version',
    'tailscale.exe version; whoami',
    'tailscale status | whoami',
    'tailscale.exe version > out.txt',
    `& (Get-Command tailscale.exe) version`,
    `& "$env:ProgramFiles\\Tailscale\\tailscale.exe" version`,
    `& "${TAILSCALE_EXE}"$(whoami)`,
    `& '${TAILSCALE_EXE}' version; whoami`,
  ];
  for (const command of badCommands) {
    assert.equal(
      trustedTailscaleInvocation(command, null, environment),
      null,
      command,
    );
  }
  assert.equal(
    trustedTailscaleInvocation('tailscale version & whoami', 'cmd.exe', environment),
    null,
  );
  for (const command of ['tailscale %PATH%', 'tailscale !PATH!', 'tailscale ^& whoami']) {
    assert.equal(trustedTailscaleInvocation(command, 'cmd.exe', environment), null);
  }
  assert.equal(
    trustedTailscaleInvocation('tailscale version', null, { platform: 'linux' }),
    null,
  );
});
