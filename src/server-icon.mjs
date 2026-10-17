import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CCM_ICON_ROUTE = '/ccm/preview/icon.png';
export const CCM_ICON_PATH = fileURLToPath(new URL('../assets/ccm-icon.png', import.meta.url));

const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_ICON_BYTES = 512 * 1024;

export function readCcmIcon(iconPath = CCM_ICON_PATH) {
  let bytes;
  try {
    bytes = fs.readFileSync(iconPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (bytes.length < PNG_HEADER.length || bytes.length > MAX_ICON_BYTES ||
      !bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER)) {
    throw new Error('CCM icon must be a PNG file of at most 512 KiB.');
  }
  return bytes;
}
