import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  MAX_VIEW_IMAGE_SOURCE_BYTES,
  viewImageFromEnvironment,
} from '../src/runtime/filesystem/view-image.mjs';

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
    assert.equal(result.compressed, false);
    assert.equal(result.data, TINY_PNG.toString('base64'));
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

test('view_image compresses oversize images without modifying the source', async () => {
  const fx = await fixture();
  try {
    const raw = Buffer.alloc(1200 * 900 * 4);
    for (let i = 0; i < raw.length; i += 4) {
      const pixel = i / 4;
      const x = pixel % 1200;
      const y = Math.floor(pixel / 1200);
      raw[i] = Math.floor(x / 5);
      raw[i + 1] = Math.floor(y / 4);
      raw[i + 2] = Math.floor((x + y) / 9);
      raw[i + 3] = 128;
    }
    const original = await sharp(raw, { raw: { width: 1200, height: 900, channels: 4 } })
      .png({ compressionLevel: 0 }).toBuffer();
    const imagePath = path.join(fx.root, 'large.png');
    await fs.writeFile(imagePath, original);
    const result = await viewImageFromEnvironment({
      environment: fx.environment,
      path: 'large.png',
      maxBytes: 80 * 1024,
    });
    assert.equal(result.compressed, true);
    assert.equal(result.mime_type, 'image/webp');
    assert.ok(result.byte_length <= 80 * 1024);
    assert.equal(result.source_byte_length, original.length);
    assert.equal(result.source_width, 1200);
    assert.equal(result.source_height, 900);
    assert.equal(result.width, 1200);
    assert.equal(result.height, 900);
    const decoded = sharp(Buffer.from(result.data, 'base64'));
    assert.equal((await decoded.metadata()).hasAlpha, true);
    assert.deepEqual(await fs.readFile(imagePath), original);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('view_image preserves a very wide image unchanged when it fits the byte budget', async () => {
  const fx = await fixture();
  try {
    const wide = await sharp({ create: {
      width: 4096, height: 16, channels: 3, background: '#123456',
    } }).png().toBuffer();
    await fs.writeFile(path.join(fx.root, 'wide.png'), wide);
    const result = await viewImageFromEnvironment({
      environment: fx.environment,
      path: 'wide.png',
    });
    assert.equal(result.compressed, false);
    assert.equal(result.width, 4096);
    assert.equal(result.height, 16);
    assert.equal(result.mime_type, 'image/png');
    assert.equal(result.data, wide.toString('base64'));
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('view_image reduces dimensions only after full-resolution low-loss attempts cannot fit', async () => {
  const fx = await fixture();
  try {
    const raw = Buffer.alloc(512 * 512 * 3);
    let seed = 271828;
    for (let i = 0; i < raw.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raw[i] = seed >>> 24;
    }
    const original = await sharp(raw, { raw: { width: 512, height: 512, channels: 3 } })
      .png().toBuffer();
    const imagePath = path.join(fx.root, 'noise.png');
    await fs.writeFile(imagePath, original);
    const result = await viewImageFromEnvironment({
      environment: fx.environment,
      path: 'noise.png',
      maxBytes: 4096,
    });
    assert.equal(result.compressed, true);
    assert.equal(result.mime_type, 'image/webp');
    assert.ok(result.byte_length <= 4096);
    assert.ok(result.width < 512);
    assert.ok(result.height < 512);
    assert.equal(result.source_width, 512);
    assert.equal(result.source_height, 512);
    assert.deepEqual(await fs.readFile(imagePath), original);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('view_image rejects source files exceeding the safe read cap', async () => {
  const fx = await fixture();
  try {
    const handle = await fs.open(path.join(fx.root, 'huge.png'), 'w');
    try {
      await handle.truncate(MAX_VIEW_IMAGE_SOURCE_BYTES + 1);
    } finally {
      await handle.close();
    }
    await assert.rejects(
      viewImageFromEnvironment({ environment: fx.environment, path: 'huge.png' }),
      /view_image source limit/,
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
