import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProxyEnvironment,
  discoverProxyUrl,
  proxyInternals,
} from '../src/runtime/proxy-env.mjs';

test('explicit CCM_PROXY wins and is injected for common proxy consumers', () => {
  const env = buildProxyEnvironment({
    CCM_PROXY: '127.0.0.1:7890',
    HTTPS_PROXY: 'http://old.example:8080',
  });

  for (const name of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
  ]) {
    assert.equal(env[name], 'http://127.0.0.1:7890');
  }
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  assert.equal(env.no_proxy, env.NO_PROXY);
});

test('existing standard proxy variables are reused without registry lookup', () => {
  let spawnCalls = 0;
  const proxy = discoverProxyUrl(
    { HTTPS_PROXY: 'http://127.0.0.1:7897' },
    () => { spawnCalls += 1; return { status: 1, stdout: '' }; },
  );
  assert.equal(proxy, 'http://127.0.0.1:7897');
  assert.equal(spawnCalls, 0);
});

test('Windows ProxyServer protocol map prefers HTTPS then HTTP', () => {
  assert.equal(
    proxyInternals.parseProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891'),
    'http://127.0.0.1:7891',
  );
  assert.equal(
    proxyInternals.parseProxyServer('127.0.0.1:7890'),
    'http://127.0.0.1:7890',
  );
});

test('Windows enabled user proxy is discovered when no proxy env is present', () => {
  const calls = [];
  const proxy = discoverProxyUrl(
    { CCM_PROXY_TEST_WINDOWS: '1' },
    (file, args) => {
      calls.push([file, args]);
      if (args.at(-1) === 'ProxyEnable') {
        return { status: 0, stdout: 'ProxyEnable    REG_DWORD    0x1\r\n' };
      }
      return { status: 0, stdout: 'ProxyServer    REG_SZ    127.0.0.1:7890\r\n' };
    },
  );
  assert.equal(proxy, 'http://127.0.0.1:7890');
  assert.equal(calls.length, 2);
});

test('CCM_PROXY_AUTO=0 disables automatic injection', () => {
  const env = buildProxyEnvironment({
    CCM_PROXY_AUTO: '0',
    CCM_PROXY: 'http://127.0.0.1:7890',
    PATH: 'test-path',
  });
  assert.deepEqual(env, {
    CCM_PROXY_AUTO: '0',
    CCM_PROXY: 'http://127.0.0.1:7890',
    PATH: 'test-path',
  });
});
