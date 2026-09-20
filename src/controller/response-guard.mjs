export const DEFAULT_MAX_MCP_TOOL_RESULT_BYTES = 512 * 1024;

export function resolveMaxMcpToolResultBytes(value) {
  const parsed = Number(value || DEFAULT_MAX_MCP_TOOL_RESULT_BYTES);
  return Number.isFinite(parsed) && parsed >= 64 * 1024
    ? parsed
    : DEFAULT_MAX_MCP_TOOL_RESULT_BYTES;
}

export function guardMcpToolResult(result, maxBytes) {
  const bytes = Buffer.byteLength(JSON.stringify(result ?? {}), 'utf8');
  if (bytes <= maxBytes) return result;

  return {
    content: [{
      type: 'text',
      text: 'CCM blocked oversized tool result (' + bytes + ' > ' +
        maxBytes + ' bytes). Reduce output or use incremental reads.',
    }],
    isError: true,
  };
}
