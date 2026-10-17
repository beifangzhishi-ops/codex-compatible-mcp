import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const DEFAULT_MAX_VIEW_IMAGE_BYTES = 1024 * 1024;
export const MAX_VIEW_IMAGE_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_VIEW_IMAGE_PIXELS = 64_000_000;

function resolveImagePath(environment, requestedPath) {
  return path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(environment.cwd, requestedPath);
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] |
    (buffer[offset + 1] << 8) |
    (buffer[offset + 2] << 16);
}

function pngMetadata(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature)) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let chunkIndex = 0;
  let sawEnd = false;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) return null;

    if (chunkIndex === 0) {
      if (type !== 'IHDR' || length !== 13) return null;
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      if (!width || !height) return null;
    }

    if (type === 'IEND') {
      if (length !== 0 || end !== buffer.length) return null;
      sawEnd = true;
      break;
    }

    offset = end;
    chunkIndex += 1;
  }

  return sawEnd ? { mimeType: 'image/png', width, height } : null;
}

function gifMetadata(buffer) {
  if (buffer.length < 14) return null;
  const header = buffer.toString('ascii', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  if (buffer.at(-1) !== 0x3b) return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  if (!width || !height) return null;
  return { mimeType: 'image/gif', width, height };
}
function jpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }
  if (buffer.lastIndexOf(Buffer.from([0xff, 0xd9])) < 2) return null;

  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ]);

  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;

    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;

    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (sofMarkers.has(marker) && length >= 7) {
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width && height) return { mimeType: 'image/jpeg', width, height };
    }
    offset += length;
  }
  return null;
}
function webpMetadata(buffer) {
  if (buffer.length < 30 ||
      buffer.toString('ascii', 0, 4) !== 'RIFF' ||
      buffer.toString('ascii', 8, 12) !== 'WEBP') {
    return null;
  }

  const declaredSize = buffer.readUInt32LE(4) + 8;
  if (declaredSize !== buffer.length) return null;

  const chunkSize = buffer.readUInt32LE(16);
  const paddedChunkEnd = 20 + chunkSize + (chunkSize % 2);
  if (paddedChunkEnd > buffer.length) return null;

  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    if (chunkSize < 10) return null;
    const width = readUInt24LE(buffer, 24) + 1;
    const height = readUInt24LE(buffer, 27) + 1;
    return width && height ? { mimeType: 'image/webp', width, height } : null;
  }

  if (chunk === 'VP8L' && buffer[20] === 0x2f) {
    if (chunkSize < 5) return null;
    const bits = buffer.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { mimeType: 'image/webp', width, height };
  }

  if (chunk === 'VP8 ' &&
      chunkSize >= 10 &&
      buffer[23] === 0x9d &&
      buffer[24] === 0x01 &&
      buffer[25] === 0x2a) {
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return width && height ? { mimeType: 'image/webp', width, height } : null;
  }

  return null;
}

function imageMetadata(buffer) {
  return pngMetadata(buffer) ||
    jpegMetadata(buffer) ||
    gifMetadata(buffer) ||
    webpMetadata(buffer);
}

async function compressImage(bytes, maxBytes) {
  // Try low-loss encoding at full resolution before sacrificing any pixels.
  const image = sharp(bytes, { limitInputPixels: MAX_VIEW_IMAGE_PIXELS }).rotate();
  for (const quality of [95, 90, 85]) {
    const output = await image.clone().webp({ quality, effort: 4 }).toBuffer();
    if (output.length <= maxBytes) return output;
  }

  // Only then shrink dimensions in small steps; never replace or modify the source.
  const { width, height } = await sharp(bytes).metadata();
  let scale = 1;
  while (Math.max(Math.round(width * scale), Math.round(height * scale)) > 1) {
    scale *= 0.85;
    const nextWidth = Math.max(1, Math.round(width * scale));
    const nextHeight = Math.max(1, Math.round(height * scale));
    for (const quality of [90, 85]) {
      const output = await image.clone()
        .resize({ width: nextWidth, height: nextHeight, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
      if (output.length <= maxBytes) return output;
    }
  }
  throw new Error('CCM view_image output limit is too small to hold a valid image');
}

export async function viewImageFromEnvironment({
  environment,
  path: requestedPath,
  maxBytes = DEFAULT_MAX_VIEW_IMAGE_BYTES,
}) {
  if (!environment) throw new Error('view_image requires an environment.');
  if (!requestedPath) throw new Error('view_image requires a path.');

  const absolutePath = resolveImagePath(environment, requestedPath);
  const stat = await fs.stat(absolutePath).catch((error) => {
    throw new Error(
      'unable to locate image at ' + absolutePath + ': ' +
      String(error?.message || error),
    );
  });
  if (!stat.isFile()) {
    throw new Error('image path is not a file: ' + absolutePath);
  }
  if (stat.size > MAX_VIEW_IMAGE_SOURCE_BYTES) {
    throw new Error(
      'image exceeds CCM view_image source limit (' + stat.size + ' > ' +
      MAX_VIEW_IMAGE_SOURCE_BYTES + ' bytes): ' + absolutePath,
    );
  }

  const bytes = await fs.readFile(absolutePath);
  const metadata = imageMetadata(bytes);
  if (!metadata) {
    throw new Error('unable to process image: invalid or unsupported image data');
  }

  if (metadata.width * metadata.height > MAX_VIEW_IMAGE_PIXELS) {
    throw new Error('image exceeds CCM view_image pixel limit (' + MAX_VIEW_IMAGE_PIXELS + ')');
  }

  const needsPreview = bytes.length > maxBytes;
  const output = needsPreview ? await compressImage(bytes, maxBytes) : bytes;
  const resultMetadata = needsPreview ? imageMetadata(output) : metadata;
  if (!resultMetadata) {
    throw new Error('unable to process compressed image');
  }

  return {
    path: absolutePath,
    mime_type: resultMetadata.mimeType,
    width: resultMetadata.width,
    height: resultMetadata.height,
    byte_length: output.length,
    source_byte_length: bytes.length,
    source_width: metadata.width,
    source_height: metadata.height,
    compressed: needsPreview,
    data: output.toString('base64'),
  };
}
