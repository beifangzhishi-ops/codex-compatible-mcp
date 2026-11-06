import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCcmConfig,
  readCcmSection,
  applyCcmBootstrapEnv,
  readWorkerCaBundle,
} from '../src/runtime/ccm-config.mjs';

const example = fileURLToPath(new URL('../ccm.config.example.json', import.meta.url));
const fixtureFile = fileURLToPath(new URL('../.cache/test-ccm-config.json', import.meta.url));

test('the tracked root template is a complete independent configuration sample', () => {
  const config = readCcmConfig(example);
  assert.equal(config.version, 1);
  assert.ok(config.controller.env.CCM_ISSUER);
  assert.ok(config.worker.env.CCM_ENVIRONMENT_ID);
  assert.ok(Array.isArray(config.trusted_commands.rules));
  assert.ok(Array.isArray(config.restart_allowlist.workers));
  assert.ok(Array.isArray(config.worker_quarantine_errors.error_codes));
  assert.match(config.codex.native_sandbox_toml, /\[windows\]/);
  assert.deepEqual(readWorkerCaBundle(example), {});
});

test('bootstrap variables are loaded from the selected JSON section, never shell child secrets', () => {
  const env = {};
  applyCcmBootstrapEnv('worker', env, example);
  assert.equal(env.CCM_ENVIRONMENT_ID, 'example-worker');
  assert.equal(env.CCM_WORKER_ID, 'example-worker');
  assert.equal(env.CCM_ISSUER, undefined);
  assert.equal(env.CURL_CA_BUNDLE, undefined);
  assert.equal(readCcmSection('controller', example).env.CCM_RESOURCE.includes('example.invalid'), true);
});

test('malformed configurations and unauthorized child overrides fail closed', () => {
  fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
  try {
    fs.writeFileSync(fixtureFile, JSON.stringify({ version: 1, worker: {} }));
    assert.throws(() => readCcmConfig(fixtureFile), /Invalid CCM configuration section/);
    const fixture = readCcmConfig(example);
    fixture.worker.child_env = { SSL_CERT_FILE: 'C:\\invalid.pem' };
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
    assert.throws(() => readWorkerCaBundle(fixtureFile), /Only CURL_CA_BUNDLE/);
    fixture.worker.child_env = { CURL_CA_BUNDLE: 'relative/path' };
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture));
    assert.throws(() => readWorkerCaBundle(fixtureFile), /absolute path/);
  } finally {
    fs.rmSync(fixtureFile, { force: true });
  }
});
