import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createConfig } from '../ccm-sidecar/config.mjs';
import { createCcmOAuthServer, listenCcmOAuthServer, closeCcmOAuthServer } from '../ccm-sidecar/server.mjs';

test('HTTPS file sidecar streams 12 MiB without OAuth and redacts URL tokens', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-publish-proxy-'));
  const token = '12345678-1234-4234-8234-123456789abc';
  const bytes = Buffer.alloc(12 * 1024 * 1024, 0x61);
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/ccm/download/' + token) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream',
      'Content-Length': bytes.length, 'Content-Disposition': 'attachment; filename="test.bin"' });
    res.end(bytes);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config = createConfig({
    rootDir: root, readEnvFile: false, port: 0, allowEphemeral: true, approvalSecret: 'A'.repeat(32),
    envValues: { CCM_ISSUER: 'https://example.test/ccm', CCM_RESOURCE: 'https://example.test/ccm/mcp' },
  });
  const server = createCcmOAuthServer({ config, downloadUpstreamPort: upstream.address().port });
  try {
    await listenCcmOAuthServer(server, 0);
    const base = 'http://127.0.0.1:' + server.server.address().port;
    const url = base + '/ccm/download/' + token;
    const received = await fetch(url);
    assert.equal(received.status, 200);
    assert.equal((await received.arrayBuffer()).byteLength, bytes.length);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '?leak=1')).status, 404);
    assert.equal((await fetch(base + '/ccm/mcp', { method: 'POST' })).status, 401);
    const trace = await fs.readFile(path.join(config.logDir, 'ccm-http.log'), 'utf8');
    assert.ok(!trace.includes(token));
    assert.match(trace, /\[redacted\]/);
  } finally {
    await closeCcmOAuthServer(server);
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('File sidecar blocks oversized upstream Content-Length and redirects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-publish-limit-'));
  const token = '12345678-1234-4234-8234-123456789abc';
  let redirect = false;
  const upstream = http.createServer((_req, res) => {
    if (redirect) { res.writeHead(302, { location: 'https://example.com' }); res.end(); }
    else { res.writeHead(200, { 'content-length': 13 * 1024 * 1024 }); res.end(); }
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config = createConfig({ rootDir: root, readEnvFile: false, port: 0, allowEphemeral: true,
    approvalSecret: 'A'.repeat(32),
    envValues: { CCM_ISSUER: 'https://example.test/ccm', CCM_RESOURCE: 'https://example.test/ccm/mcp' } });
  const server = createCcmOAuthServer({ config, downloadUpstreamPort: upstream.address().port });
  try {
    await listenCcmOAuthServer(server, 0);
    const url = 'http://127.0.0.1:' + server.server.address().port + '/ccm/download/' + token;
    assert.equal((await fetch(url)).status, 502);
    redirect = true;
    assert.equal((await fetch(url)).status, 502);
  } finally {
    await closeCcmOAuthServer(server);
    await new Promise((resolve) => upstream.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
