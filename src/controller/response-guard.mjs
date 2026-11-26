import { randomUUID } from 'node:crypto';

export const DEFAULT_MAX_MCP_TOOL_RESULT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_MCP_FILE_RESULT_BYTES = 24 * 1024 * 1024;

export function resolveMaxMcpToolResultBytes(value) {
  const parsed = Number(value || DEFAULT_MAX_MCP_TOOL_RESULT_BYTES);
  return Number.isFinite(parsed) && parsed >= 64 * 1024
    ? parsed
    : DEFAULT_MAX_MCP_TOOL_RESULT_BYTES;
}

export function resolveMaxMcpFileResultBytes(value) {
  const parsed = Number(value || DEFAULT_MAX_MCP_FILE_RESULT_BYTES);
  return Number.isFinite(parsed) && parsed >= 64 * 1024
    ? parsed
    : DEFAULT_MAX_MCP_FILE_RESULT_BYTES;
}

function hasEmbeddedFile(result) {
  return Array.isArray(result?.content) && result.content.some(
    (item) => item?.type === 'resource' &&
      typeof item?.resource?.blob === 'string',
  );
}

export function usesEmbeddedImages(userAgent) {
  return typeof userAgent === 'string' && userAgent.trim().toLowerCase() === 'google';
}

function embedImages(result) {
  if (!Array.isArray(result?.content) || !result.content.some(item => item.type === 'image')) return result;
  return {
    ...result,
    content: result.content.map(item => {
      if (item.type !== 'image') return item;
      const { type, data, mimeType, ...metadata } = item;
      return {
        ...metadata,
        type: 'resource',
        resource: { uri: `urn:ccm:image:${randomUUID()}`, mimeType, blob: data },
      };
    }),
  };
}

export function guardMcpToolResult(
  result,
  maxBytes,
  maxFileBytes = DEFAULT_MAX_MCP_FILE_RESULT_BYTES,
  userAgent,
) {
  // Select the original result's limit before changing its wire representation.
  const effectiveMax = hasEmbeddedFile(result) ? maxFileBytes : maxBytes;
  let bytes = Buffer.byteLength(JSON.stringify(result ?? {}), 'utf8');
  if (bytes <= effectiveMax) {
    const adapted = usesEmbeddedImages(userAgent) ? embedImages(result) : result;
    if (adapted !== result) bytes = Buffer.byteLength(JSON.stringify(adapted), 'utf8');
    if (bytes <= effectiveMax) return adapted;
  }

  return {
    content: [{
      type: 'text',
      text: 'CCM blocked oversized tool result (' + bytes + ' > ' +
        effectiveMax + ' bytes). Reduce output or use a smaller file.',
    }],
    isError: true,
  };
}
