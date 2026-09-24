import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writeJsonAtomicSync(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(
      temp,
      JSON.stringify(value, null, 2) + '\n',
      { encoding: 'utf8', flag: 'w' },
    );
    fs.renameSync(temp, filePath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

