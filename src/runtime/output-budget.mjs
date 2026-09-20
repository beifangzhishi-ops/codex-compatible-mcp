export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
export const MAX_CAPTURE_BYTES = 1024 * 1024;
const APPROX_CHARS_PER_TOKEN = 4;

export function approxTokenCount(text) {
  return Math.ceil(String(text ?? '').length / APPROX_CHARS_PER_TOKEN);
}

export function capCapturedOutput(text, maxBytes = MAX_CAPTURE_BYTES) {
  const source = String(text ?? '');
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes <= maxBytes) return { text: source, omittedBytes: 0 };

  const budget = Math.floor(maxBytes / 2);
  const head = Buffer.from(source, 'utf8').subarray(0, budget).toString('utf8');
  const tailBuffer = Buffer.from(source, 'utf8');
  const tail = tailBuffer.subarray(Math.max(0, tailBuffer.length - budget)).toString('utf8');
  const omittedBytes = Math.max(0, bytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
  return {
    text: `${head}\n... ${omittedBytes} bytes omitted ...\n${tail}`,
    omittedBytes,
  };
}

export function boundOutput(text, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS) {
  const source = String(text ?? '');
  const maxChars = Math.max(256, Number(maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS) * APPROX_CHARS_PER_TOKEN);
  const originalTokenCount = approxTokenCount(source);

  if (source.length <= maxChars) {
    return { output: source, truncated: false, originalTokenCount };
  }

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = Math.max(0, maxChars - headChars);
  const omitted = source.length - headChars - tailChars;
  return {
    output: source.slice(0, headChars) +
      `\n... ${omitted} chars truncated ...\n` +
      source.slice(source.length - tailChars),
    truncated: true,
    originalTokenCount,
  };
}
