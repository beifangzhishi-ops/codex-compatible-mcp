import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
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

test('OAuth sidecar safely persists initialize data and recovers a stale upstream session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-oauth-session-'));
  let upstreamSession = 0;
  let activeSession = null;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (payload.method === 'initialize') {
        upstreamSession += 1;
        activeSession = 'upstream-' + upstreamSession;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', activeSession);
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fake-upstream', version: '1' },
          },
        }));
        return;
      }
      if (request.headers['mcp-session-id'] !== activeSession) {
        response.statusCode = 400;
        response.end('invalid session');
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { ok: true },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

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
  const store = new OAuthStore(config.stateFile);
  const client = store.registerClient(metadata());
  const verifier = 'B'.repeat(64);
  const code = store.createAuthorizationCode({
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeChallenge: createPkceChallenge(verifier),
    codeChallengeMethod: 'S256',
    resource: config.resource,
    scope: 'mcp',
  });
  const token = store.exchangeAuthorizationCode({
    code,
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeVerifier: verifier,
    resource: config.resource,
    tokenTtlSeconds: 3600,
  }).accessToken;

  let runtime = createCcmOAuthServer({
    config,
    oauthStore: store,
    upstreamUrl: 'http://127.0.0.1:' + upstreamPort,
  });
  try {
    await listenCcmOAuthServer(runtime, 0);
    let base = 'http://127.0.0.1:' + runtime.server.address().port;
    const headers = {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const initialized = await fetch(base + '/ccm/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'sidecar-recovery-test', version: '1' },
        },
      }),
    });
    assert.equal(initialized.status, 200);

    const persisted = JSON.parse(
      await fs.readFile(config.upstreamSessionFile, 'utf8'),
    );
    assert.equal(persisted.version, 2);
    assert.equal(persisted.initializeRequest.payload.method, 'initialize');
    assert.equal(persisted.initializeRequest.headers.authorization, undefined);

    await closeCcmOAuthServer(runtime);
    runtime = null;
    activeSession = 'stale-session';

    runtime = createCcmOAuthServer({
      config,
      oauthStore: store,
      upstreamUrl: 'http://127.0.0.1:' + upstreamPort,
    });
    await listenCcmOAuthServer(runtime, 0);
    base = 'http://127.0.0.1:' + runtime.server.address().port;
    const toolResponse = await fetch(base + '/ccm/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'noop', arguments: {} },
      }),
    });
    assert.equal(toolResponse.status, 200);
    assert.equal(upstreamSession, 2);
  } finally {
    if (runtime) await closeCcmOAuthServer(runtime);
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OAuth sidecar isolates repeated JSON-RPC ids across sessionless requests', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-oauth-isolation-'));
  let upstreamSession = 0;
  const toolSessions = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (payload.method === 'initialize') {
        upstreamSession += 1;
        const sessionId = 'isolated-' + upstreamSession;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', sessionId);
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fake-upstream', version: '1' },
          },
        }));
        return;
      }
      if (request.method === 'DELETE') {
        response.statusCode = 200;
        response.end();
        return;
      }
      const sessionId = request.headers['mcp-session-id'];
      toolSessions.push(sessionId);
      const label = payload.params?.arguments?.label || 'unknown';
      const delay = label === 'slow' ? 60 : 5;
      setTimeout(() => {
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: { label, sessionId },
        }));
      }, delay);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

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
  const store = new OAuthStore(config.stateFile);
  const client = store.registerClient(metadata());
  const verifier = 'D'.repeat(64);
  const code = store.createAuthorizationCode({
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeChallenge: createPkceChallenge(verifier),
    codeChallengeMethod: 'S256',
    resource: config.resource,
    scope: 'mcp',
  });
  const token = store.exchangeAuthorizationCode({
    code,
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeVerifier: verifier,
    resource: config.resource,
    tokenTtlSeconds: 3600,
  }).accessToken;
  const runtime = createCcmOAuthServer({
    config,
    oauthStore: store,
    upstreamUrl: 'http://127.0.0.1:' + upstreamPort,
  });
  try {
    await listenCcmOAuthServer(runtime, 0);
    const base = 'http://127.0.0.1:' + runtime.server.address().port;
    const headers = {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const initialized = await fetch(base + '/ccm/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'sidecar-isolation-test', version: '1' },
        },
      }),
    });
    assert.equal(initialized.status, 200);

    const call = (label) => fetch(base + '/ccm/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'tools/call',
        params: { name: 'noop', arguments: { label } },
      }),
    }).then(async (result) => ({
      status: result.status,
      session: result.headers.get('mcp-session-id'),
      body: await result.json(),
    }));

    const [slow, fast] = await Promise.all([call('slow'), call('fast')]);
    assert.equal(slow.status, 200);
    assert.equal(fast.status, 200);
    assert.equal(slow.body.result.label, 'slow');
    assert.equal(fast.body.result.label, 'fast');
    assert.equal(slow.session, null);
    assert.equal(fast.session, null);
    assert.equal(toolSessions.length, 2);
    assert.equal(new Set(toolSessions).size, 2);
    assert.equal(upstreamSession, 3);
  } finally {
    await closeCcmOAuthServer(runtime);
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OAuth sidecar gives each downstream initialize its own upstream session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-oauth-init-scope-'));
  let upstreamSession = 0;
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (payload.method === 'initialize') {
        upstreamSession += 1;
        const sessionId = 'client-' + upstreamSession;
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', sessionId);
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fake-upstream', version: '1' },
          },
        }));
        return;
      }
      response.statusCode = 200;
      response.end('{}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
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
  const store = new OAuthStore(config.stateFile);
  const client = store.registerClient(metadata());
  const verifier = 'E'.repeat(64);
  const code = store.createAuthorizationCode({
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeChallenge: createPkceChallenge(verifier),
    codeChallengeMethod: 'S256',
    resource: config.resource,
    scope: 'mcp',
  });
  const token = store.exchangeAuthorizationCode({
    code,
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeVerifier: verifier,
    resource: config.resource,
    tokenTtlSeconds: 3600,
  }).accessToken;
  const runtime = createCcmOAuthServer({
    config,
    oauthStore: store,
    upstreamUrl: 'http://127.0.0.1:' + upstreamPort,
  });
  try {
    await listenCcmOAuthServer(runtime, 0);
    const base = 'http://127.0.0.1:' + runtime.server.address().port;
    const headers = {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const initialize = (id, name) => fetch(base + '/ccm/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name, version: '1' },
        },
      }),
    });
    const first = await initialize(1, 'client-a');
    const second = await initialize(1, 'client-b');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(
      first.headers.get('mcp-session-id'),
      second.headers.get('mcp-session-id'),
    );
    assert.equal(upstreamSession, 2);
  } finally {
    await closeCcmOAuthServer(runtime);
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OAuth sidecar refreshes an invalid downstream session with that client initialize template', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-oauth-refresh-scope-'));
  let upstreamSession = 0;
  const sessionClient = new Map();
  const invalidSessions = new Set();
  const initializeClients = [];
  const upstream = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (payload.method === 'initialize') {
        upstreamSession += 1;
        const clientName = payload.params?.clientInfo?.name || 'unknown';
        const sessionId = 'refresh-' + upstreamSession;
        initializeClients.push(clientName);
        sessionClient.set(sessionId, clientName);
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.setHeader('mcp-session-id', sessionId);
        response.end(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            serverInfo: { name: 'fake-upstream', version: '1' },
          },
        }));
        return;
      }
      if (request.method === 'DELETE') {
        response.statusCode = 200;
        response.end();
        return;
      }
      const sessionId = request.headers['mcp-session-id'];
      if (invalidSessions.has(sessionId)) {
        response.statusCode = 400;
        response.end('invalid session');
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        result: { client: sessionClient.get(sessionId) },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
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
  const store = new OAuthStore(config.stateFile);
  const client = store.registerClient(metadata());
  const verifier = 'F'.repeat(64);
  const code = store.createAuthorizationCode({
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeChallenge: createPkceChallenge(verifier),
    codeChallengeMethod: 'S256',
    resource: config.resource,
    scope: 'mcp',
  });
  const token = store.exchangeAuthorizationCode({
    code,
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeVerifier: verifier,
    resource: config.resource,
    tokenTtlSeconds: 3600,
  }).accessToken;
  const runtime = createCcmOAuthServer({
    config,
    oauthStore: store,
    upstreamUrl: 'http://127.0.0.1:' + upstreamPort,
  });
  try {
    await listenCcmOAuthServer(runtime, 0);
    const base = 'http://127.0.0.1:' + runtime.server.address().port;
    const headers = {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const initialize = async (name) => fetch(base + '/ccm/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name, version: '1' },
        },
      }),
    });

    const clientA = await initialize('client-a');
    const clientB = await initialize('client-b');
    const sessionA = clientA.headers.get('mcp-session-id');
    const sessionB = clientB.headers.get('mcp-session-id');
    assert.notEqual(sessionA, sessionB);
    invalidSessions.add(sessionA);

    const tool = await fetch(base + '/ccm/mcp', {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': sessionA },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'tools/call',
        params: { name: 'noop', arguments: {} },
      }),
    });
    assert.equal(tool.status, 200);
    const body = await tool.json();
    assert.equal(body.result.client, 'client-a');
    assert.deepEqual(initializeClients, ['client-a', 'client-b', 'client-a']);
  } finally {
    await closeCcmOAuthServer(runtime);
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('OAuth sidecar declines session-multiplexed GET SSE instead of sharing one upstream stream', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-oauth-get-'));
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
  const store = new OAuthStore(config.stateFile);
  const client = store.registerClient(metadata());
  const verifier = 'C'.repeat(64);
  const code = store.createAuthorizationCode({
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeChallenge: createPkceChallenge(verifier),
    codeChallengeMethod: 'S256',
    resource: config.resource,
    scope: 'mcp',
  });
  const token = store.exchangeAuthorizationCode({
    code,
    clientId: client.clientId,
    redirectUri: metadata().redirect_uris[0],
    codeVerifier: verifier,
    resource: config.resource,
    tokenTtlSeconds: 3600,
  }).accessToken;
  const runtime = createCcmOAuthServer({ config, oauthStore: store });
  try {
    await listenCcmOAuthServer(runtime, 0);
    const base = 'http://127.0.0.1:' + runtime.server.address().port;
    const response = await fetch(base + '/ccm/mcp', {
      method: 'GET',
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST, DELETE');
  } finally {
    await closeCcmOAuthServer(runtime);
    await fs.rm(root, { recursive: true, force: true });
  }
});
