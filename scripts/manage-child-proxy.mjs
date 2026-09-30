import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChildProxyPolicy,
  defaultChildProxyStateFile,
} from '../src/runtime/child-proxy-policy.mjs';
import { discoverProxyUrl } from '../src/runtime/proxy-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.CCM_INSTALL_ROOT ||= root;

const stateFile = defaultChildProxyStateFile();
const action = String(process.argv[2] || 'status').trim().toLowerCase();

if (!['status', 'proxy', 'direct'].includes(action)) {
  console.error('Usage: node scripts/manage-child-proxy.mjs <status|proxy|direct>');
  process.exit(2);
}

async function writeMode(mode) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  const temp = stateFile + '.' + process.pid + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify({ mode }) + '\n', 'utf8');
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(temp, stateFile);
        break;
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 5) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  } finally {
    await fs.unlink(temp).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

if (action !== 'status') {
  await writeMode(action);
}

const policy = new ChildProxyPolicy({ file: stateFile });
const mode = policy.getMode();
console.log('mode=' + mode);
console.log('state_file=' + stateFile);
if (action === 'status' && mode === 'proxy') {
  console.log('proxy_url=' + (discoverProxyUrl(process.env) || '(none discovered)'));
}
