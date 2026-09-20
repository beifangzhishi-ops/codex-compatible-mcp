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

export function guardMcpToolResult(
  result,
  maxBytes,
  maxFileBytes = DEFAULT_MAX_MCP_FILE_RESULT_BYTES,
) {
  const bytes = Buffer.byteLength(JSON.stringify(result ?? {}), 'utf8');
  const effectiveMax = hasEmbeddedFile(result) ? maxFileBytes : maxBytes;
  if (bytes <= effectiveMax) return result;

  return {
    content: [{
      type: 'text',
      text: 'CCM blocked oversized tool result (' + bytes + ' > ' +
        effectiveMax + ' bytes). Reduce output or use a smaller file.',
    }],
    isError: true,
  };
}
