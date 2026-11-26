import * as z from 'zod/v4';
import { readFileSync } from 'node:fs';
import { usesEmbeddedImages } from '../controller/response-guard.mjs';

const formats = ['native', 'mixed', 'embedded', 'inline_data', 'markdown_data_uri', 'text_control',
  'mp3_native', 'mp3_embedded', 'native_assistant', 'embedded_assistant',
  'resource_link', 'resource_link_mp3', 'structured_inline', 'structured_parts'];
const text = (value) => ({ type: 'text', text: value });
const mimeType = 'audio/wav';
const wavUri = 'urn:ccm:test-audio-content';
const mp3Uri = 'urn:ccm:test-audio-content:mp3';
const assistant = { audience: ['assistant'], priority: 1 };

// Deterministic, synthetic PCM fixture; no device, file or network access.
function fixture() {
  const sampleRate = 16000;
  const pattern = [[440, 180], [0, 100], [440, 180], [0, 550],
    [880, 180], [0, 100], [880, 180], [0, 100], [880, 180], [0, 550], [660, 550]];
  const samples = pattern.reduce((total, [, ms]) => total + sampleRate * ms / 1000, 0);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  let offset = 44;
  for (const [frequency, duration] of pattern) {
    const count = sampleRate * duration / 1000;
    for (let i = 0; i < count; i++) {
      const envelope = Math.min(1, i / 160, (count - 1 - i) / 160);
      wav.writeInt16LE(Math.round(14000 * envelope * Math.sin(2 * Math.PI * frequency * i / sampleRate)), offset);
      offset += 2;
    }
  }
  return wav.toString('base64');
}

function mp3Fixture() {
  return readFileSync(new URL('../../assets/gemini-audio-probe.mp3', import.meta.url)).toString('base64');
}

// These fixed synthetic resources are registered only in Google sessions.
export function registerAudioProbeResources(server) {
  for (const [uri, name, mime, getData] of [
    [wavUri, 'ccm-test-audio.wav', mimeType, fixture],
    [mp3Uri, 'ccm-test-audio.mp3', 'audio/mpeg', mp3Fixture],
  ]) {
    server.registerResource(name, uri, { mimeType: mime, description: 'Synthetic audio compatibility test only.', annotations: assistant },
      async (_uri, extra) => {
        if (!usesEmbeddedImages(extra?.requestInfo?.headers?.['user-agent'])) throw new Error('Google MCP client required.');
        return { contents: [{ uri, mimeType: mime, blob: getData() }] };
      });
  }
}

export function registerAudioProbe(registry) {
  registry.register({
    name: 'test_audio_content', namespace: 'ccm-extra', provider: 'ccm-specialized',
    tags: ['audio', 'test'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: 'Temporary Gemini MCP audio compatibility test only; no practical functionality. Returns the same synthetic sound in the selected WAV/MP3 or resource/structured format. For resource_link and resource_link_mp3, try standard MCP resources/read if supported by the host. Test formats separately. Report only actual audible tone groups, relative pitches, timing or whether audio was unavailable; do not guess or decode Base64. text_control checks text delivery alone.',
    inputSchema: { format: z.enum(formats).default('native') },
    handler: async ({ format = 'native' }, { extra } = {}) => {
      if (!usesEmbeddedImages(extra?.requestInfo?.headers?.['user-agent'])) {
        return { isError: true, content: [text('Gemini audio compatibility probe requires a Google MCP client.')] };
      }
      if (format === 'text_control') return { content: [text('CCM_AUDIO_TEXT_CONTROL_OK')] };
      if (format === 'resource_link' || format === 'resource_link_mp3') {
        const mp3 = format === 'resource_link_mp3';
        return { content: [{ type: 'resource_link', uri: mp3 ? mp3Uri : wavUri,
          name: mp3 ? 'ccm-test-audio.mp3' : 'ccm-test-audio.wav',
          mimeType: mp3 ? 'audio/mpeg' : mimeType, annotations: assistant }] };
      }
      if (format === 'mp3_native' || format === 'mp3_embedded') {
        const data = mp3Fixture();
        return { content: [format === 'mp3_native'
          ? { type: 'audio', mimeType: 'audio/mpeg', data }
          : { type: 'resource', resource: { uri: mp3Uri, mimeType: 'audio/mpeg', blob: data } }] };
      }
      const data = fixture();
      const audio = { type: 'audio', data, mimeType };
      if (format === 'structured_inline' || format === 'structured_parts') {
        // Deliberately no duplicate base64 in TextContent: isolate structuredContent transport.
        return { content: [], structuredContent: format === 'structured_inline'
          ? { inlineData: { mimeType, data } }
          : { result: [{ type: 'audio', mime_type: mimeType, data }] } };
      }
      return { content: {
        native: [audio],
        mixed: [text('CCM_AUDIO_TEST_MARKER'), audio],
        embedded: [{ type: 'resource', resource: { uri: wavUri, mimeType, blob: data } }],
        native_assistant: [{ ...audio, annotations: assistant }],
        embedded_assistant: [{ type: 'resource', resource: { uri: wavUri, mimeType, blob: data }, annotations: assistant }],
        inline_data: [text(JSON.stringify({ inlineData: { mimeType, data } }))],
        markdown_data_uri: [text(`[Test audio](data:${mimeType};base64,${data})`)],
      }[format] };
    },
  });
}
