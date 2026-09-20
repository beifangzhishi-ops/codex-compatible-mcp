import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MAX_SEND_FILE_BYTES = 12 * 1024 * 1024;

const MIME_BY_EXTENSION = new Map(Object.entries({
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.rtf': 'application/rtf',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}));

function resolveFilePath(environment, requestedPath) {
  return path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(environment.cwd, requestedPath);
}

function mimeTypeFor(filePath) {
  return MIME_BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ||
    'application/octet-stream';
}

export async function sendFileFromEnvironment({
  environment,
  path: requestedPath,
  maxBytes = DEFAULT_MAX_SEND_FILE_BYTES,
}) {
  if (!environment) throw new Error('send_file requires an environment.');
  if (!requestedPath) throw new Error('send_file requires a path.');

  const absolutePath = resolveFilePath(environment, requestedPath);
  const stat = await fs.stat(absolutePath).catch((error) => {
    throw new Error(
      'unable to locate file at ' + absolutePath + ': ' +
      String(error?.message || error),
    );
  });
  if (!stat.isFile()) {
    throw new Error('file path is not a file: ' + absolutePath);
  }
  if (stat.size > maxBytes) {
    throw new Error(
      'file exceeds CCM send_file limit (' + stat.size + ' > ' +
      maxBytes + ' bytes): ' + absolutePath,
    );
  }

  const bytes = await fs.readFile(absolutePath);
  return {
    path: absolutePath,
    filename: path.basename(absolutePath),
    mime_type: mimeTypeFor(absolutePath),
    byte_length: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    data: bytes.toString('base64'),
  };
}
