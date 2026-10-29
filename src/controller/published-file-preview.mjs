import { isPreviewableTextMime } from './text-file-preview.mjs';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp']);
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/mp4', 'audio/webm', 'audio/aac', 'audio/flac']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']);
const MARKUP_TYPES = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);

export const ISOLATED_MARKUP_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

export function publishedPreviewKind(mime) {
  const type = String(mime || '').split(';', 1)[0].trim().toLowerCase();
  if (MARKUP_TYPES.has(type)) return 'markup';
  if (IMAGE_TYPES.has(type)) return 'image';
  if (type === 'application/pdf') return 'document';
  if (AUDIO_TYPES.has(type)) return 'audio';
  if (VIDEO_TYPES.has(type)) return 'video';
  if (isPreviewableTextMime(type)) return 'text';
  return null;
}
