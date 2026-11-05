// Thin IPC adapter to the unchanged OpenAI Codex Tree-sitter PowerShell lowerer,
// pinned at ed8eac40832e6a79f30eaeb3c521912f231d43eb.
// The native program returns null for scripts Codex cannot safely lower;
// this adapter must never execute the user script or invent fallback tokens.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_CODEX_POWERSHELL_PARSER_PATH = fileURLToPath(
  new URL('../../../native/bin/' +
    (process.platform === 'win32'
      ? 'ccm-codex-powershell-parser.exe' : 'ccm-codex-powershell-parser'),
  import.meta.url),
);

export function parseCodexPowerShellScript(script, {
  executable = DEFAULT_CODEX_POWERSHELL_PARSER_PATH,
  spawn = spawnSync,
  exists = fs.existsSync,
} = {}) {
  if (typeof script !== 'string' || !script.trim() || !exists(executable)) {
    return null;
  }
  const result = spawn(executable, [], {
    input: JSON.stringify({ script }) + '\n',
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  try {
    const response = JSON.parse(result.stdout.trim());
    const commands = response?.commands;
    if (!Array.isArray(commands) || !commands.length ||
        commands.some((words) => !Array.isArray(words) || !words.length ||
          words.some((word) => typeof word !== 'string' || word.length === 0))) {
      return null;
    }
    return commands;
  } catch {
    return null;
  }
}
