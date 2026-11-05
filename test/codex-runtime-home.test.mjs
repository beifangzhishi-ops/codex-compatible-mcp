import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexRuntimeHome, provisionCodexRuntimeHome } from '../src/runtime/sandbox/codex-runtime-home.mjs';

test('Codex runtime home is independent of the interactive Codex user config', () => {
  assert.equal(
    codexRuntimeHome({ localAppData: 'C:\\Users\\tester\\AppData\\Local' }),
    'C:\\Users\\tester\\AppData\\Local\\CCM\\CodexSandbox',
  );
  assert.throws(() => codexRuntimeHome({ localAppData: '' }), /LOCALAPPDATA is missing/);
  assert.throws(() => codexRuntimeHome({ localAppData: 'relative' }), /LOCALAPPDATA is missing/);
});

test('Codex runtime bootstrap persists exact native TOML and refuses mismatched config', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows paths only');
  const cache = fileURLToPath(new URL('../.cache/', import.meta.url));
  fs.mkdirSync(cache, { recursive: true });
  const temp = fs.mkdtempSync(path.join(cache, 'ccm-codex-home-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const template = path.join(temp, 'source.toml');
  const home = path.join(temp, 'protected-home');
  const config = path.join(home, 'config.toml');
  fs.writeFileSync(template, '[windows]\nsandbox = "elevated"\n');
  assert.equal(provisionCodexRuntimeHome({ home, template }), home);
  assert.equal(fs.readFileSync(config, 'utf8'), '[windows]\nsandbox = "elevated"\n');
  assert.equal(provisionCodexRuntimeHome({ home, template }), home);
  fs.writeFileSync(config, 'some unrelated config');
  assert.throws(() => provisionCodexRuntimeHome({ home, template }), /refusing to overwrite/);
  assert.equal(fs.readFileSync(config, 'utf8'), 'some unrelated config');
});
