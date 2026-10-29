import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultHelperPath = fileURLToPath(
  new URL('../../native/bin/ccm-worker-token-owner.exe', import.meta.url),
);

export function normalizeWorkerTokenOwner({
  platform = process.platform,
  helperPath = defaultHelperPath,
  existsSync = fs.existsSync,
  spawn = spawnSync,
} = {}) {
  if (platform !== 'win32') return;
  if (!existsSync(helperPath)) {
    throw new Error('Windows token-owner helper is missing: run npm run build:native.');
  }
  const result = spawn(helperPath, [], {
    cwd: path.dirname(helperPath),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      'Could not set CCM Worker default file owner: ' +
      String(result.error?.message || result.stderr?.trim() ||
        'exit code ' + result.status),
    );
  }
}
