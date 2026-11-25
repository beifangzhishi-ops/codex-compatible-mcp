import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { guardMcpToolResult } from '../controller/response-guard.mjs';

// Temporary Host-specific compatibility probe. No Worker or file-path access.
export function registerGeminiAudioProbe(server, clientInfo, maxToolResultBytes) {
  if (!/gemini|google/i.test(clientInfo?.name || '')) return;
  server.registerTool('listen_audio', {
    description: 'Temporary Gemini MCP compatibility test only; has no practical audio-reading functionality. Returns a random text marker and a fixed synthetic WAV. Report the marker and what you actually hear separately; never guess.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const data = await fs.readFile(new URL('../../assets/gemini-audio-probe.wav', import.meta.url));
    const marker = randomBytes(6).toString('hex');
    return guardMcpToolResult({ content: [{
      type: 'text', text: 'TEST ONLY: no practical audio-reading functionality. Text control marker: ' + marker,
    }, {
      type: 'audio', mimeType: 'audio/wav', data: data.toString('base64'),
    }] }, maxToolResultBytes);
  });
}
