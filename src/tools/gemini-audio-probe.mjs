import fs from 'node:fs/promises';
import { guardMcpToolResult } from '../controller/response-guard.mjs';

// Temporary Host-specific compatibility probe. No Worker or file-path access.
export function registerGeminiAudioProbe(server, clientInfo, maxToolResultBytes) {
  if (!/gemini|google/i.test(clientInfo?.name || '')) return;
  server.registerTool('listen_audio', {
    description: 'Experimental Gemini audio context test. Returns a synthetic WAV containing speech and other sounds. Listen to the audio and report what you actually hear.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const data = await fs.readFile(new URL('../../assets/gemini-audio-probe.wav', import.meta.url));
    return guardMcpToolResult({ content: [{
      type: 'audio', mimeType: 'audio/wav', data: data.toString('base64'),
    }] }, maxToolResultBytes);
  });
}
