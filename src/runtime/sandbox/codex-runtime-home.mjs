import fs from 'node:fs';
import path from 'node:path';
import { readCcmSection } from '../ccm-config.mjs';

// The Codex CLI owns its native config, credentials, ACL setup and sandbox
// accounts. CCM only supplies a separate, machine-local Codex home to avoid
// modifying a person's interactive Codex preferences.
export function codexRuntimeHome({
  localAppData = process.env.LOCALAPPDATA,
} = {}) {
  if (!localAppData || !path.win32.isAbsolute(localAppData)) {
    throw new Error('Cannot locate a user-local Codex home: LOCALAPPDATA is missing.');
  }
  return path.win32.join(localAppData, 'CCM', 'CodexSandbox');
}

/**
 * Trusted Worker bootstrap; never run through a sandboxed user command.
 * Existing config is accepted only if it matches the repository's native
 * Codex TOML template, so accidental edits cannot silently change profiles.
 */
export function provisionCodexRuntimeHome({
  home = codexRuntimeHome(),
  template = null,
  filesystem = fs,
} = {}) {
  if (!path.win32.isAbsolute(home)) {
    throw new Error('Codex runtime home must be an absolute Windows path.');
  }
  const content = template
    ? filesystem.readFileSync(template, 'utf8')
    : readCcmSection('codex').native_sandbox_toml;
  if (typeof content !== 'string' || !content.includes('[windows]')) {
    throw new Error('Invalid codex.native_sandbox_toml configuration.');
  }
  const configPath = path.win32.join(home, 'config.toml');
  filesystem.mkdirSync(home, { recursive: true });
  if (filesystem.existsSync(configPath)) {
    if (filesystem.readFileSync(configPath, 'utf8') !== content) {
      throw new Error('Dedicated Codex config differs from CCM native config; refusing to overwrite it.');
    }
  } else {
    filesystem.writeFileSync(configPath, content, { encoding: 'utf8', flag: 'wx' });
  }
  return home;
}
