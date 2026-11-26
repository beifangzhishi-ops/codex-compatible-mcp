import * as z from 'zod/v4';
import { usesEmbeddedImages } from '../controller/response-guard.mjs';

const formats = ['native', 'mixed', 'embedded', 'inline_data', 'markdown_data_uri', 'text_control'];
const text = (value) => ({ type: 'text', text: value });
const mimeType = 'audio/wav';

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

export function registerAudioProbe(registry) {
  registry.register({
    name: 'test_audio_content', namespace: 'ccm-extra', provider: 'ccm-specialized',
    tags: ['audio', 'test'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: 'Temporary Gemini MCP audio compatibility test only; no practical functionality. Returns the same synthetic WAV in one requested format. Test formats separately. Report only actual audible tone groups, relative pitches, timing or whether audio was unavailable; do not guess. text_control checks text delivery alone.',
    inputSchema: { format: z.enum(formats).default('native') },
    handler: async ({ format = 'native' }, { extra } = {}) => {
      if (!usesEmbeddedImages(extra?.requestInfo?.headers?.['user-agent'])) {
        return { isError: true, content: [text('Gemini audio compatibility probe requires a Google MCP client.')] };
      }
      if (format === 'text_control') return { content: [text('CCM_AUDIO_TEXT_CONTROL_OK')] };
      const data = fixture();
      const audio = { type: 'audio', data, mimeType };
      return { content: {
        native: [audio],
        mixed: [text('CCM_AUDIO_TEST_MARKER'), audio],
        embedded: [{ type: 'resource', resource: { uri: 'urn:ccm:test-audio-content', mimeType, blob: data } }],
        inline_data: [text(JSON.stringify({ inlineData: { mimeType, data } }))],
        markdown_data_uri: [text(`[Test audio](data:${mimeType};base64,${data})`)],
      }[format] };
    },
  });
}
