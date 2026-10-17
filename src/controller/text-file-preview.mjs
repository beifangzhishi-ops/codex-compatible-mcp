export const INLINE_TEXT_LIMIT = 8 * 1024;

export function isPreviewableTextMime(mime) {
  const type = String(mime || '').split(';', 1)[0].trim().toLowerCase();
  return type.startsWith('text/') ||
    ['application/json', 'application/ld+json', 'application/xml',
      'application/javascript', 'application/x-javascript',
      'application/x-yaml', 'application/yaml', 'application/toml',
      'application/sql'].includes(type) ||
    /^application\/[-\w.]+\+(?:json|xml|yaml)$/.test(type);
}

// Decode only a small prefix and never place binary, invalid UTF-8 or null
// bytes inside a ChatGPT tool result. The file itself stays in the cache.
export function textPreviewFromBase64(base64, mime) {
  if (!isPreviewableTextMime(mime) || typeof base64 !== 'string') return null;
  const bytes = Buffer.from(base64, 'base64');
  let length = Math.min(bytes.length, INLINE_TEXT_LIMIT);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // Trimming is only allowed at the bounded-preview cut; a short file with
  // malformed UTF-8 must not become an empty or silently shortened preview.
  if (bytes.length <= INLINE_TEXT_LIMIT) {
    try {
      const text = decoder.decode(bytes);
      return text.includes('\0') ? null : { text, truncated: false };
    } catch { return null; }
  }
  for (let i = 0; i < 4 && length >= 0; i++, length--) {
    try {
      const text = decoder.decode(bytes.subarray(0, length));
      if (text.includes('\0')) return null;
      return { text, truncated: length < bytes.length };
    } catch {}
  }
  return null;
}
