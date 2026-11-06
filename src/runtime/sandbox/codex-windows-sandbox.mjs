import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { directShellInvocation } from './native-sandbox.mjs';
import { codexRuntimeHome } from './codex-runtime-home.mjs';

// The sandbox argv and permissions TOML were verified against upstream Codex
// at f79b26ccbb3116b052544666a181012fb45dc49b. The installed Codex CLI
// version is deliberately NOT pinned: select the newest complete installation.
const HELPERS = ['codex.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe'];

function parseCodexCliVersion(output) {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
    .exec(String(output).trim());
  return match ? {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') || [],
  } : null;
}

function compareCodexCliVersions(left, right) {
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i]) {
      return left.numbers[i] > right.numbers[i] ? 1 : -1;
    }
  }
  if (!left.prerelease.length) return right.prerelease.length ? 1 : 0;
  if (!right.prerelease.length) return -1;
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const aa = BigInt(a), bb = BigInt(b);
      if (aa !== bb) return aa > bb ? 1 : -1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else {
      return a > b ? 1 : -1;
    }
  }
  return 0;
}

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
 * Select the newest installed Codex CLI that has its command runner and setup
 * helper alongside it. No fixed CLI version is required.
 * Equal-version duplicates remain ambiguous rather than picking arbitrarily.
 * This is a lookup of the trusted host's installed binary, not a search in PATH.
 */
export function resolveCodexRuntime({
  binRoot = path.win32.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
  readdir = fs.readdirSync,
  isFile = (candidate) => fs.statSync(candidate).isFile(),
  execute = spawnSync,
} = {}) {
  const root = windowsPath(binRoot, 'Codex installation root');
  const matches = [];
  const launchDenied = [];
  for (const entry of readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.win32.join(root, entry.name);
    const executables = HELPERS.map((name) => path.win32.join(directory, name));
    try {
      if (!executables.every((candidate) => isFile(candidate))) continue;
    } catch {
      continue;
    }
    let result;
    try {
      result = execute(executables[0], ['--version'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
    } catch (error) {
      result = { error };
    }
    if (['EPERM', 'EACCES'].includes(result?.error?.code)) {
      launchDenied.push(result.error.code);
      continue;
    }
    const version = !result.error && result.status === 0
      ? parseCodexCliVersion(result.stdout) : null;
    if (version) {
      matches.push({ executable: executables[0], version });
    }
  }
  if (!matches.length) {
    if (launchDenied.length) {
      throw new Error(
        'Codex CLI and both native helpers are installed, but the current Worker ' +
        'cannot launch codex.exe (' + launchDenied[0] + '). This is a host execution ' +
        'permission failure, not a missing installation or a CLI version mismatch. ' +
        'Run the native sandbox integration test from a trusted elevated Windows host.',
      );
    }
    throw new Error(
      'Codex sandbox requires an installed Codex CLI with its native command runner ' +
      'and sandbox setup helper in the same directory.',
    );
  }
  matches.sort((a, b) => compareCodexCliVersions(b.version, a.version));
  if (matches.length > 1 &&
      compareCodexCliVersions(matches[0].version, matches[1].version) === 0) {
    throw new Error('Multiple equally recent Codex CLI installations were found; ' +
      'unable to choose a unique native sandbox runtime.');
  }
  return matches[0].executable;
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
 * those belong entirely to the installed upstream Codex and its paired helpers.
 *
 * This backend is NOT enabled by default until end-to-end containment tests pass.
 */
export class CodexWindowsSandboxBackend {
  constructor({
    resolveRuntime = resolveCodexRuntime,
    codexHome = codexRuntimeHome(),
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
    if (permissionProfile === 'full-access') {
      return {
        ...directShellInvocation({
          platform: 'windows', shell: shell || environment.shell, command, useProfile,
        }),
        sandboxed: false,
        permissionProfile,
      };
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
    // Resolve a complete Codex installation before spawn. No CLI version pin.
    // There is no unrestricted executable-path override in the production API.
    const codexExecutable = windowsPath(this.resolveRuntime(), 'Codex CLI');
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
