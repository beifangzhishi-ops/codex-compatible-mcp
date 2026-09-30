import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ChildProxyPolicy,
  parseChildProxyPolicy,
} from '../src/runtime/child-proxy-policy.mjs';

test('child proxy policy defaults to proxy when state file is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-child-proxy-'));
  try {
    const policy = new ChildProxyPolicy({
      file: path.join(root, 'child-proxy.json'),
      log: () => {},
    });
    assert.equal(policy.getMode(), 'proxy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('child proxy policy hot reloads proxy/direct and keeps last known-good mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-child-proxy-'));
  const file = path.join(root, 'child-proxy.json');
  const logs = [];
  try {
    const policy = new ChildProxyPolicy({
      file,
      log: (level, message) => logs.push({ level, message }),
    });

    fs.writeFileSync(file, '{"mode":"direct"}\n', 'utf8');
    assert.equal(policy.getMode(), 'direct');

    fs.writeFileSync(file, '{"mode":"broken"}\n', 'utf8');
    assert.equal(policy.getMode(), 'direct');
    assert.equal(logs.length, 1);
    assert.match(logs[0].message, /last known-good mode direct/);

    assert.equal(policy.getMode(), 'direct');
    assert.equal(logs.length, 1, 'same invalid content should not spam logs');

    fs.writeFileSync(file, '{"mode":"proxy"}\n', 'utf8');
    assert.equal(policy.getMode(), 'proxy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('child proxy policy parser accepts only current proxy/direct schema', () => {
  assert.deepEqual(parseChildProxyPolicy('{"mode":"proxy"}'), { mode: 'proxy' });
  assert.deepEqual(parseChildProxyPolicy('{"mode":"direct"}'), { mode: 'direct' });
  assert.throws(() => parseChildProxyPolicy('{"enabled":false}'), /mode/);
  assert.throws(() => parseChildProxyPolicy('{"mode":"backup"}'), /mode/);
});
