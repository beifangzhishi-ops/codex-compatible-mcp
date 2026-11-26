import sharp from 'sharp';
import * as z from 'zod/v4';
import { usesEmbeddedImages } from '../controller/response-guard.mjs';

const formats = ['native', 'mixed', 'embedded', 'inline_data', 'markdown_data_uri', 'text_control', 'client_info'];
const text = (value) => ({ type: 'text', text: value });

// Fixed synthetic fixture, drawn without system fonts or user files.
const segments = ['M8 5H42', 'M45 8V38', 'M45 48V78', 'M8 81H42', 'M5 48V78', 'M5 8V38', 'M8 43H42'];
const digits = [[0,5,6,2,3], [0,1,2,3,4,5,6], [0,1,6,2,3], [0,1,2]];
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300" viewBox="0 0 480 300">
  <rect width="480" height="300" fill="white"/>
  <polygon points="120,30 50,150 190,150" fill="#8034b5"/>
  <circle cx="360" cy="90" r="60" fill="#16863d"/>
  <g fill="none" stroke="#171717" stroke-width="8" stroke-linecap="round">
    ${digits.map((parts, index) => `<g transform="translate(${111 + index * 70} 185)">${parts.map(i => `<path d="${segments[i]}"/>`).join('')}</g>`).join('')}
  </g>
</svg>`;

export function registerImageProbe(registry) {
  registry.register({
    name: 'test_image_content',
    namespace: 'ccm-extra',
    provider: 'ccm-specialized',
    tags: ['image', 'test'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: 'Temporary MCP compatibility test only; no practical functionality. Returns a fixed synthetic PNG in one requested format. Call each format separately, report the actual visible shapes, colors and digits, or say unavailable. Do not guess. text_control tests text delivery only; client_info reports server-observed client identity and proposed image routing.',
    inputSchema: { format: z.enum(formats).default('native') },
    handler: async ({ format = 'native' }, { extra, clientInfo } = {}) => {
      if (format === 'client_info') {
        const bounded = (value) => typeof value === 'string' ? value.slice(0, 512) : null;
        const userAgent = bounded(extra?.requestInfo?.headers?.['user-agent']);
        const isGoogle = usesEmbeddedImages(userAgent);
        return { content: [text(JSON.stringify({
          user_agent: userAgent,
          client_info: { name: bounded(clientInfo?.name), version: bounded(clientInfo?.version) },
          google_user_agent_match: isGoogle,
          proposed_image_format: isGoogle ? 'embedded' : 'native',
          routing_applied: false,
        }))] };
      }
      if (format === 'text_control') return { content: [text('CCM_TEXT_CONTROL_OK')] };
      const data = (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
      const mimeType = 'image/png';
      const image = { type: 'image', data, mimeType };
      const content = {
        native: [image],
        mixed: [text('CCM_IMAGE_TEST_MARKER'), image],
        embedded: [{ type: 'resource', resource: { uri: 'urn:ccm:test-image-content', mimeType, blob: data } }],
        inline_data: [text(JSON.stringify({ inlineData: { mimeType, data } }))],
        markdown_data_uri: [text(`![Test image](data:${mimeType};base64,${data})`)],
      }[format];
      return { content };
    },
  });
}
