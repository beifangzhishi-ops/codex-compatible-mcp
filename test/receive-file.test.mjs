import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  receiveFileFromEnvironment,
  receiveFileInternals,
} from '../src/runtime/filesystem/receive-file.mjs';

function fakeResponse(chunks, {
  statusCode = 200,
  headers = {},
} = {}) {
  const response = Readable.from(
    (Array.isArray(chunks) ? chunks : [chunks]).map((chunk) =>
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))),
  );
  response.statusCode = statusCode;
  response.headers = headers;
  return response;
}

async function tempEnvironment() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-receive-file-'));
  return {
    root,
    environment: {
      id: 'test-worker',
      cwd: root,
      workspaceRoots: [root],
      permissionProfile: 'workspace-write',
    },
  };
}

test('receive_file streams one file into the workspace and returns sha256', async () => {
  const { root, environment } = await tempEnvironment();
  const bytes = Buffer.from('hello receive file');
  let seenProxy = null;
  try {
    const result = await receiveFileFromEnvironment({
      environment,
      file: {
        download_url: 'https://files.example.test/token?secret=redacted',
        file_id: 'file_test',
        mime_type: 'text/plain',
        file_name: 'report.txt',
      },
      proxyUrl: 'http://127.0.0.1:7890',
      openResponse: async (url, options) => {
        assert.equal(url.hostname, 'files.example.test');
        seenProxy = options.proxyUrl;
        return fakeResponse(bytes, {
          headers: { 'content-length': String(bytes.length) },
        });
      },
    });
    assert.equal(seenProxy, 'http://127.0.0.1:7890');
    assert.equal(result.filename, 'report.txt');
    assert.equal(result.file_id, 'file_test');
    assert.equal(result.byte_length, bytes.length);
    assert.equal(
      result.sha256,
      crypto.createHash('sha256').update(bytes).digest('hex'),
    );
    assert.deepEqual(await fs.readFile(path.join(root, 'report.txt')), bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('receive_file default filename is basename-sanitized', async () => {
  const { root, environment } = await tempEnvironment();
  try {
    const result = await receiveFileFromEnvironment({
      environment,
      file: {
        download_url: 'https://files.example.test/file',
        file_id: 'file_name',
        file_name: '../../unsafe?.txt',
      },
      proxyUrl: null,
      openResponse: async () => fakeResponse('ok'),
    });
    assert.equal(result.filename, 'unsafe_.txt');
    assert.equal(await fs.readFile(path.join(root, 'unsafe_.txt'), 'utf8'), 'ok');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('receive_file rejects absolute and escaping destinations', async () => {
  const { root, environment } = await tempEnvironment();
  try {
    for (const destination of [
      path.resolve(root, '..', 'outside.txt'),
      '..' + path.sep + 'outside.txt',
    ]) {
      await assert.rejects(
        receiveFileFromEnvironment({
          environment,
          file: {
            download_url: 'https://files.example.test/file',
            file_id: 'file_escape',
            file_name: 'safe.txt',
          },
          destination,
          proxyUrl: null,
          openResponse: async () => fakeResponse('never'),
        }),
        /destination (must be relative|escapes)/i,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('receive_file does not overwrite by default and replaces only when requested', async () => {
  const { root, environment } = await tempEnvironment();
  const target = path.join(root, 'same.txt');
  try {
    await fs.writeFile(target, 'old');
    await assert.rejects(
      receiveFileFromEnvironment({
        environment,
        file: {
          download_url: 'https://files.example.test/file',
          file_id: 'file_existing',
          file_name: 'same.txt',
        },
        proxyUrl: null,
        openResponse: async () => fakeResponse('new'),
      }),
      /already exists/i,
    );
    assert.equal(await fs.readFile(target, 'utf8'), 'old');

    await receiveFileFromEnvironment({
      environment,
      file: {
        download_url: 'https://files.example.test/file',
        file_id: 'file_existing',
        file_name: 'same.txt',
      },
      overwrite: true,
      proxyUrl: null,
      openResponse: async () => fakeResponse('new'),
    });
    assert.equal(await fs.readFile(target, 'utf8'), 'new');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('receive_file enforces declared and streamed size limits without partial target', async () => {
  const { root, environment } = await tempEnvironment();
  try {
    await assert.rejects(
      receiveFileFromEnvironment({
        environment,
        file: {
          download_url: 'https://files.example.test/declared',
          file_id: 'file_declared',
          file_name: 'declared.bin',
        },
        maxBytes: 4,
        proxyUrl: null,
        openResponse: async () => fakeResponse('12345', {
          headers: { 'content-length': '5' },
        }),
      }),
      /exceeds size limit/i,
    );
    await assert.rejects(fs.stat(path.join(root, 'declared.bin')), /ENOENT/);

    await assert.rejects(
      receiveFileFromEnvironment({
        environment,
        file: {
          download_url: 'https://files.example.test/streamed',
          file_id: 'file_streamed',
          file_name: 'streamed.bin',
        },
        maxBytes: 4,
        proxyUrl: null,
        openResponse: async () => fakeResponse(['12', '345']),
      }),
      /exceeds size limit while downloading/i,
    );
    await assert.rejects(fs.stat(path.join(root, 'streamed.bin')), /ENOENT/);
    const leftovers = (await fs.readdir(root)).filter((name) =>
      name.includes('.ccm-receive-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('receive_file rejects non-HTTPS redirects and invalid URLs without echoing tokens', async () => {
  const { root, environment } = await tempEnvironment();
  try {
    await assert.rejects(
      receiveFileFromEnvironment({
        environment,
        file: {
          download_url: 'https://files.example.test/start?secret=one',
          file_id: 'file_redirect',
          file_name: 'redirect.bin',
        },
        proxyUrl: null,
        openResponse: async () => fakeResponse('', {
          statusCode: 302,
          headers: { location: 'http://example.com/insecure' },
        }),
      }),
      /non-HTTPS/i,
    );

    await assert.rejects(
      receiveFileFromEnvironment({
        environment,
        file: {
          download_url: 'not-a-url?secret=must-not-echo',
          file_id: 'file_invalid',
          file_name: 'invalid.bin',
        },
        proxyUrl: null,
        openResponse: async () => fakeResponse('never'),
      }),
      (error) => {
        assert.match(error.message, /invalid download URL/i);
        assert.doesNotMatch(error.message, /must-not-echo/);
        return true;
      },
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('receive_file SSRF checks reject private, loopback, link-local, and mixed DNS answers', async () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(receiveFileInternals.isPublicAddress(address), false, address);
  }
  assert.equal(receiveFileInternals.isPublicAddress('8.8.8.8'), true);
  assert.equal(
    receiveFileInternals.isPublicAddress('2606:4700:4700::1111'),
    true,
  );

  await assert.rejects(
    receiveFileInternals.resolvePublicTarget(
      'files.example.test',
      async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    ),
    /non-public download target/i,
  );
});

test('receive_file HTTPS transport explicitly tunnels through the discovered HTTP proxy', async () => {
  let connectTarget = null;
  const proxy = http.createServer();
  proxy.on('connect', (request, socket) => {
    connectTarget = request.url;
    socket.write('HTTP/1.1 502 Bad Gateway\\r\\nConnection: close\\r\\n\\r\\n');
    socket.destroy();
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const port = proxy.address().port;
    await assert.rejects(
      receiveFileInternals.openHttpsResponse(
        new URL('https://files.example.test/download'),
        {
          lookup: async () => [{ address: '8.8.8.8', family: 4 }],
          proxyUrl: 'http://127.0.0.1:' + port,
          connectTimeoutMs: 1000,
        },
      ),
    );
    assert.equal(connectTarget, '8.8.8.8:443');
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test('receive_file refuses read-only environments', async () => {
  const { root, environment } = await tempEnvironment();
  environment.permissionProfile = 'read-only';
  try {
    await assert.rejects(
      receiveFileFromEnvironment({
        environment,
        file: {
          download_url: 'https://files.example.test/file',
          file_id: 'file_ro',
          file_name: 'ro.txt',
        },
        proxyUrl: null,
        openResponse: async () => fakeResponse('never'),
      }),
      /read-only/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
