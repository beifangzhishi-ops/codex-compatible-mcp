import crypto from 'node:crypto';

function normalizeCommand(value) {
  return String(value || '').trim();
}

export function parsePackageScriptCommand(command) {
  const value = normalizeCommand(command);
  if (/^npm(?:\.cmd)?\s+test$/i.test(value)) {
    return { package_manager: 'npm', script: 'test' };
  }
  const match = value.match(
    /^(npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?)\s+run\s+([A-Za-z0-9:_-]+)$/i,
  );
  if (!match) return null;
  return {
    package_manager: match[1].toLowerCase().replace(/\.cmd$/, ''),
    script: match[2],
  };
}

export function hashPackageScript(scriptText) {
  return crypto
    .createHash('sha256')
    .update(String(scriptText))
    .digest('hex');
}

