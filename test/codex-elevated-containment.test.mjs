// An opt-in native Windows boundary test. It provisions only disposable paths.
// Run from a TRUSTED elevated Worker process, never by nesting under CCM's
// restricted token, and do not enable in regular CI.
//
// Baseline: openai/codex f79b26ccbb3116b052544666a181012fb45dc49b.
// Known unresolved issue: a preexisting hardlink can cause Codex's workspace
// ACL grant to make the same file writable via an outside-workspace path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePinnedCodexRuntime, codexWorkspaceRootsOverride } from '../src/runtime/sandbox/codex-windows-sandbox.mjs';

const ENABLED = process.platform === 'win32' &&
  process.env.CCM_RUN_CODEX_ELEVATED_CONTAINMENT === '1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));

test('upstream Elevated Sandbox cannot make an outside file writable via a hardlink', {
  skip: !ENABLED && 'requires explicit trusted Windows integration run',
}, (t) => {
  const cli = resolvePinnedCodexRuntime();
  const fixtureRoot = path.join(ROOT, '..', '.cache', 'codex-elevated-integration-' + randomUUID());
  const workspace = path.join(fixtureRoot, 'workspace');
  const cwd = path.join(workspace, 'sub');
  const outside = path.join(fixtureRoot, 'outside');
  const victim = path.join(outside, 'victim.txt');
  const link = path.join(cwd, 'linked-victim.txt');
  const inside = path.join(cwd, 'allowed.txt');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(victim, 'ORIGINAL', 'utf8');
  fs.linkSync(victim, link);
  const quotePs = (value) => "'" + value.replaceAll("'", "''") + "'";
  const script = [
    "$ErrorActionPreference='Stop'",
    "Set-Content -LiteralPath " + quotePs(inside) + " -Value 'ALLOWED'",
    "try {Set-Content -LiteralPath " + quotePs(victim) + " -Value 'BREACHED' -ErrorAction Stop; Write-Output 'OUTSIDE_BREACH'} catch {Write-Output 'OUTSIDE_DENIED'}",
    "try {Set-Content -LiteralPath " + quotePs(link) + " -Value 'BREACHED' -ErrorAction Stop; Write-Output 'LINK_BREACH'} catch {Write-Output 'LINK_DENIED'}",
  ].join('; ');
  const args = [
    'sandbox', '-P', 'workspace-online', '-C', cwd,
    '-c', 'permissions.workspace-online.extends=":workspace"',
    '-c', 'permissions.workspace-online.network.enabled=true',
    '-c', codexWorkspaceRootsOverride(workspace),
    '-c', 'windows.sandbox="elevated"',
    '--', path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ];
  try {
    const result = spawnSync(cli, args, { encoding: 'utf8', windowsHide: true, timeout: 45000 });
    t.diagnostic('exit=' + result.status + ' stderr=' + String(result.stderr).slice(0, 1200));
    t.diagnostic('stdout=' + String(result.stdout).slice(0, 1000));
    assert.equal(result.status, 0, 'Codex sandbox did not start');
    assert.equal(fs.readFileSync(inside, 'utf8').trim(), 'ALLOWED');
    assert.match(String(result.stdout), /OUTSIDE_DENIED/);
    assert.match(String(result.stdout), /LINK_DENIED/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
