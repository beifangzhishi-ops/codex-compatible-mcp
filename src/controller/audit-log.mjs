import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const installRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

export function createAuditLogger({
  file = process.env.CCM_AUDIT_LOG ||
    path.join(installRoot, 'logs', 'ccm-audit.log'),
  now = () => new Date(),
} = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (event = {}) => {
    try {
      const record = {
        timestamp: now().toISOString(),
        ...event,
      };
      fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
    } catch {}
  };
}
