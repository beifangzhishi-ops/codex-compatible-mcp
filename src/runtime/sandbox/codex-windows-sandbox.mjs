import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { directShellInvocation } from './native-sandbox.mjs';

// Both values are from upstream openai/codex at f79b26ccbb3116b052544666a181012fb45dc49b.
// The installed CLI, setup helper and command runner must be from the same release.
export const PINNED_CODEX_VERSION = 'codex-cli 0.166.0-alpha.5.1';
export const PINNED_CODEX_COMMIT = 'f79b26ccbb3116b052544666a181012fb45dc49b';
const HELPERS = ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe'];

function windowsPath(value, name) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value)) {
    throw new Error(name + ' must be an absolute Windows path.');
  }
  return path.win32.normalize(value);
}

function isWithinWindowsRoot(root, candidate) {
  const relative = path.win32.relative(root, candidate);
  return relative === '' || (
    !relative.startsWith('..' + path.win32.sep) &&
    relative !== '..' &&
    !path.win32.isAbsolute(relative)
  );
}

/**
 * Find one installed copy of the exact upstream Codex version.
 * A version mismatch, missing helper, or ambiguous installation fails closed.
 * This is a lookup of the trusted host's installed binary, not a search in PATH.
 */
export function resolvePinnedCodexRuntime({
  binRoot = path.win32.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
  readdir = fs.readdirSync,
  isFile = (candidate) => fs.statSync(candidate).isFile(),
  execute = spawnSync,
} = {}) {
  const root = windowsPath(binRoot, 'Codex installation root');
  const matches = [];
  for (const entry of readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.win32.join(root, entry.name);
    const executables = HELPERS.map((name) => path.win32.join(directory, name));
    try {
      if (!executables.every((candidate) => isFile(candidate))) continue;
    } catch {
      continue;
    }
    const result = execute(executables[0], ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (!result.error && result.status === 0 &&
        String(result.stdout).trim() === PINNED_CODEX_VERSION) {
      matches.push(executables[0]);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      'Codex sandbox requires exactly one verified ' + PINNED_CODEX_VERSION +
      ' runtime with both native helpers; found ' + matches.length + '. Refusing to substitute another version.',
    );
  }
  return matches[0];
}

// Upstream: codex-rs/config/src/permissions_toml.rs, WorkspaceRootsToml.
// A literal TOML inline table is passed as one argv element, not interpolated
// into an executable command. JSON string encoding is valid TOML basic-string
// encoding for Windows paths.
export function codexWorkspaceRootsOverride(workspaceRoot) {
  const root = windowsPath(workspaceRoot, 'Workspace root');
  return 'permissions.workspace-online.workspace_roots={ ' +
    JSON.stringify(root) + ' = true }';
}

/**
 * Staged transport adapter for Codex's own Windows sandbox CLI.
 * Does not create Windows tokens, ACLs, firewall rules or sandbox users:
 * those belong entirely to the pinned upstream command and setup helpers.
 *
 * This backend is NOT enabled by default until end-to-end containment tests pass.
 */
export class CodexWindowsSandboxBackend {
  constructor({
    resolveRuntime = resolvePinnedCodexRuntime,
    codexHome,
    fileExists = fs.existsSync,
  } = {}) {
    this.resolveRuntime = resolveRuntime;
    this.codexHome = codexHome;
    this.fileExists = fileExists;
  }

  buildInvocation({
    environment, command, cwd, shell, permissionProfile, tty, useProfile = false,
  }) {
    if (environment.platform !== 'windows') {
      throw new Error('Upstream Codex Windows sandbox is Windows-only.');
    }
    if (!['workspace-write', 'read-only'].includes(permissionProfile)) {
      throw new Error('Codex sandbox cannot accept CCM-specific or unsandboxed profile: ' + permissionProfile);
    }
    const root = windowsPath(environment.workspaceRoots?.[0] || environment.cwd, 'Workspace root');
    const workdir = windowsPath(cwd, 'Command workdir');
    if (!isWithinWindowsRoot(root, workdir)) {
      throw new Error('Refusing Codex sandbox launch outside the registered workspace.');
    }
    const codexHome = windowsPath(this.codexHome, 'Dedicated Codex runtime home');
    if (isWithinWindowsRoot(root, codexHome) || isWithinWindowsRoot(codexHome, root)) {
      throw new Error('Codex runtime home must be separate from the writable workspace.');
    }
    if (!this.fileExists(path.win32.join(codexHome, 'config.toml'))) {
      throw new Error('Codex runtime home is missing its native config.toml.');
    }
    // Always resolve and verify the binary and helper versions before spawn.
    // There is no unrestricted executable-path override in the production API.
    const codexExecutable = windowsPath(this.resolveRuntime(), 'Pinned Codex binary');
    const commandInvocation = directShellInvocation({
      platform: 'windows',
      shell: shell || environment.shell,
      command,
      useProfile,
    });
    const profile = permissionProfile === 'workspace-write' ? 'workspace-online' : 'read-only';
    const args = ['sandbox', '-P', profile, '-C', workdir];
    if (permissionProfile === 'workspace-write') {
      args.push('-c', codexWorkspaceRootsOverride(root));
    }
    args.push('--', commandInvocation.file, ...commandInvocation.args);
    return {
      file: codexExecutable,
      args,
      sandboxed: true,
      permissionProfile,
      // Native Codex isolation is established by a trusted Worker launcher.
      // The child MUST use the separate, protected CODEX_HOME, never a writable
      // workspace-owned or user's unrelated personal Codex configuration.
      environmentOverrides: { CODEX_HOME: codexHome },
      tty,
    };
  }
}
