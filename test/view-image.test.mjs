import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { viewImageFromEnvironment } from '../src/runtime/filesystem/view-image.mjs';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2F+QAAAAASUVORK5CYII=',
  'base64',
);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-image-'));
  return {
    root,
    environment: {
      id: 'image-test',
      cwd: root,
      workspaceRoots: [root],
      permissionProfile: 'workspace-write',
    },
  };
}

test('view_image returns bounded PNG metadata and bytes', async () => {
  const fx = await fixture();
  try {
    await fs.writeFile(path.join(fx.root, 'tiny.png'), TINY_PNG);
    const result = await viewImageFromEnvironment({
      environment: fx.environment,
      path: 'tiny.png',
    });
    assert.equal(result.mime_type, 'image/png');
    assert.equal(result.width, 1);
    assert.equal(result.height, 1);
    assert.equal(Buffer.from(result.data, 'base64').length, TINY_PNG.length);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('view_image rejects non-image data', async () => {
  const fx = await fixture();
  try {
    await fs.writeFile(path.join(fx.root, 'fake.png'), 'not an image');
    await assert.rejects(
      viewImageFromEnvironment({
        environment: fx.environment,
        path: 'fake.png',
      }),
      /invalid or unsupported image data/,
    );
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('view_image enforces size before returning bytes', async () => {
  const fx = await fixture();
  try {
    await fs.writeFile(path.join(fx.root, 'large.png'), TINY_PNG);
    await assert.rejects(
      viewImageFromEnvironment({
        environment: fx.environment,
        path: 'large.png',
        maxBytes: 16,
      }),
      /view_image limit/,
    );
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});


test('view_image rejects structurally truncated PNG data', async () => {
  const fx = await fixture();
  try {
    const truncated = TINY_PNG.subarray(0, 33);
    await fs.writeFile(path.join(fx.root, 'truncated.png'), truncated);
    await assert.rejects(
      viewImageFromEnvironment({
        environment: fx.environment,
        path: 'truncated.png',
      }),
      /invalid or unsupported image data/,
    );
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});
