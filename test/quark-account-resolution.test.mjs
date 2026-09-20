import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(repoRoot, 'tools', 'quark-transfer', 'cloud_transfer.py');

function hasPython() {
  try {
    execFileSync('python', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runResolver(local, indexed, accounts) {
  const script = [
    'import importlib.util, pathlib, sys',
    'helper, local, indexed, *accounts = sys.argv[1:]',
    'spec = importlib.util.spec_from_file_location("qt", helper)',
    'qt = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(qt)',
    'value = qt._latest_cache_account(accounts, [pathlib.Path(local), pathlib.Path(indexed)])',
    'print(value or "")',
  ].join('; ');
  return execFileSync('python', [
    '-c', script, helper, local, indexed, ...accounts,
  ], { encoding: 'utf8' }).trim();
}

test('Quark 7.x cache account resolver picks the newest unambiguous namespace', {
  skip: !hasPython(),
}, () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'ccm-quark-account-'));
  try {
    const local = path.join(temp, 'local');
    const indexed = path.join(temp, 'indexed');
    mkdirSync(local);
    mkdirSync(indexed);
    const oldId = 'OLD_ACCOUNT_ID_1234567890';
    const activeId = 'ACTIVE_ACCOUNT_123456789';
    writeFileSync(path.join(local, '000001.log'),
      `home-card-cache:${oldId}\nnoise\nhome-card-cache:${activeId}\n`);
    writeFileSync(path.join(indexed, '000004.log'),
      `response-cache:${activeId}\n`);
    assert.equal(runResolver(local, indexed, [oldId, activeId]), activeId);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('Quark 7.x cache account resolver fails closed when storage roots disagree', {
  skip: !hasPython(),
}, () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'ccm-quark-account-'));
  try {
    const local = path.join(temp, 'local');
    const indexed = path.join(temp, 'indexed');
    mkdirSync(local);
    mkdirSync(indexed);
    const accountA = 'ACCOUNT_A_12345678901234';
    const accountB = 'ACCOUNT_B_12345678901234';
    writeFileSync(path.join(local, '000001.log'), `home-card-cache:${accountA}\n`);
    writeFileSync(path.join(indexed, '000004.log'), `response-cache:${accountB}\n`);
    assert.equal(runResolver(local, indexed, [accountA, accountB]), '');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
