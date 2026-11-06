import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationChildEnvironment } from '../src/worker/conversation-service.mjs';

test('conversation import inherits the Worker proxy mode and certificate bundle', () => {
  const env = conversationChildEnvironment({ action: 'import' }, {
    baseEnv: { CCM_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' },
    proxyMode: 'proxy',
    caBundle: { CURL_CA_BUNDLE: 'C:\\trusted-ca.pem' },
  });
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.CURL_CA_BUNDLE, 'C:\\trusted-ca.pem');
  assert.equal(env.CCM_CONVERSATION_PROXY_MODE, 'proxy');
});

test('conversation import honors direct mode without implicit Worker proxies', () => {
  const env = conversationChildEnvironment({ action: 'import' }, {
    baseEnv: {
      CCM_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      https_proxy: 'http://127.0.0.1:7890',
    },
    proxyMode: 'direct',
    caBundle: {},
  });
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.https_proxy, undefined);
  assert.equal(env.CCM_PROXY, undefined);
  assert.equal(env.CCM_CONVERSATION_PROXY_MODE, 'direct');
});

test('an explicit import proxy overrides the selected Worker mode', () => {
  const env = conversationChildEnvironment({
    action: 'import', proxy: 'http://127.0.0.1:7891',
  }, {
    baseEnv: { CCM_PROXY: 'http://127.0.0.1:7890' },
    proxyMode: 'direct',
    caBundle: {},
  });
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7891/');
  assert.equal(env.CCM_CONVERSATION_PROXY_MODE, 'proxy');
  assert.throws(() => conversationChildEnvironment({
    action: 'import', proxy: 'file:///tmp/proxy',
  }, { caBundle: {} }), /HTTP or HTTPS/);
});
