import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConfig } from '../ccm-sidecar/config.mjs';
import {
  OAuthStore,
  createPkceChallenge,
} from '../ccm-sidecar/oauth.mjs';
import {
  closeCcmOAuthServer,
  createCcmOAuthServer,
  listenCcmOAuthServer,
} from '../ccm-sidecar/server.mjs';

function metadata() {
  return {
    client_name: 'ccm-oauth-test',
    redirect_uris: ['http://127.0.0.1:19001/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

test('OAuth config exposes CCM protected-resource identities', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-oauth-config-'));
  try {
    const config = createConfig({
      rootDir: root,
      readEnvFile: false,
      envValues: {
        CCM_ISSUER: 'https://example.test/ccm',
        CCM_RESOURCE: 'https://example.test/ccm/mcp',
      },
      allowEphemeral: true,
    });

    assert.equal(config.issuer, 'https://example.test/ccm');
    assert.equal(config.resource, 'https://example.test/ccm/mcp');
    assert.equal(
      config.protectedResourceMetadataUrl,
      'https://example.test/.well-known/oauth-protected-resource/ccm/mcp',
    );
    assert.equal(
      config.authorizationServerMetadataUrl,
      'https://example.test/.well-known/oauth-authorization-server/ccm',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OAuth store enforces PKCE, refresh rotation, and family revocation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-oauth-store-'));
  try {
    const resource = 'https://example.test/ccm/mcp';
    const store = new OAuthStore(path.join(root, 'state.json'));

    assert.throws(
      () => store.registerClient({
        ...metadata(),
        redirect_uris: ['http://example.com/callback'],
      }),
      (error) => error?.code === 'invalid_redirect_uri',
    );

    const client = store.registerClient(metadata());
    const verifier = 'A'.repeat(64);
    const code = store.createAuthorizationCode({
      clientId: client.clientId,
      redirectUri: metadata().redirect_uris[0],
      codeChallenge: createPkceChallenge(verifier),
      codeChallengeMethod: 'S256',
      resource,
      scope: 'mcp',
    });

    const first = store.exchangeAuthorizationCode({
      code,
      clientId: client.clientId,
      redirectUri: metadata().redirect_uris[0],
      codeVerifier: verifier,
      resource,
      tokenTtlSeconds: 3600,
    });
    assert.equal(
      store.validateAccessToken(first.accessToken, resource)?.clientId,
      client.clientId,
    );

    const second = store.exchangeRefreshToken({
      refreshToken: first.refreshToken,
      clientId: client.clientId,
      resource,
      scope: null,
      tokenTtlSeconds: 3600,
    });
    assert.notEqual(second.refreshToken, first.refreshToken);

    assert.equal(store.revokeToken(second.refreshToken), true);
    assert.equal(store.validateAccessToken(second.accessToken, resource), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('OAuth sidecar serves metadata and bearer challenge', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-oauth-http-'));
  const config = createConfig({
    rootDir: root,
    readEnvFile: false,
    envValues: {
      CCM_ISSUER: 'https://example.test/ccm',
      CCM_RESOURCE: 'https://example.test/ccm/mcp',
    },
    port: 0,
    allowEphemeral: true,
    approvalSecret: 'A'.repeat(32),
  });
  const runtime = createCcmOAuthServer({ config });
  try {
    await listenCcmOAuthServer(runtime, 0);
    const address = runtime.server.address();
    const base = 'http://127.0.0.1:' + address.port;

    const metadataResponse = await fetch(
      base + '/.well-known/oauth-authorization-server/ccm',
    );
    assert.equal(metadataResponse.status, 200);
    const metadataBody = await metadataResponse.json();
    assert.equal(metadataBody.issuer, 'https://example.test/ccm');
    assert.equal(metadataBody.code_challenge_methods_supported[0], 'S256');

    const protectedResponse = await fetch(base + '/ccm/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(protectedResponse.status, 401);
    assert.match(
      protectedResponse.headers.get('www-authenticate') || '',
      /oauth-protected-resource\/ccm\/mcp/,
    );
  } finally {
    await closeCcmOAuthServer(runtime);
    await fs.rm(root, { recursive: true, force: true });
  }
});
