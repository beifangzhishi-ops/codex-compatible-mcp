import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directShellInvocation } from './native-sandbox.mjs';
import { codexRuntimeHome } from './codex-runtime-home.mjs';

// These three binaries are built from the same pinned upstream Codex source.
// There is no dependency on a separately installed Codex CLI.
const BIN_DIR = fileURLToPath(new URL('../../../native/bin/', import.meta.url));
const NATIVE_RUNNER = 'ccm-codex-native-sandbox.exe';
const UPSTREAM_HELPERS = [
  'codex-command-runner.exe',
  'codex-windows-sandbox-setup.exe',
];

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

/** Resolve only CCM-built, colocated Codex Windows sandbox binaries.
 * Neither PATH nor an installed codex.exe is consulted.
 */
export function resolveNativeCodexRuntime({
  binDir = BIN_DIR,
  fileExists = (candidate) => fs.statSync(candidate).isFile(),
} = {}) {
  const root = windowsPath(binDir, 'CCM native sandbox binary directory');
  const files = [NATIVE_RUNNER, ...UPSTREAM_HELPERS].map(
    (name) => path.win32.join(root, name),
  );
  const missing = files.filter((file) => {
    try { return !fileExists(file); } catch { return true; }
  });
  if (missing.length) {
    throw new Error(
      'CCM-native Codex sandbox is not built: missing ' +
      missing.map((file) => path.win32.basename(file)).join(', ') +
      '. Build the upstream Rust runner and its two helpers with ' +
      'npm run build:codex-native. No external Codex CLI is required.',
    );
  }
  return files[0];
}

/**
 * The experimental Windows backend calls a CCM-owned Rust entrypoint that
 * invokes codex-windows-sandbox directly. It neither reimplements ACLs/tokens
 * nor shells out to codex.exe. It is not the production Worker default.
 */
export class CodexWindowsSandboxBackend {
  constructor({
    resolveRuntime = resolveNativeCodexRuntime,
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
      throw new Error('Codex sandbox cannot accept unsupported CCM profile: ' +
        permissionProfile);
    }
    const root = windowsPath(environment.workspaceRoots?.[0] || environment.cwd,
      'Workspace root');
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
    // Verify the CCM-built native binaries, not any installed Codex CLI.
    const executable = windowsPath(this.resolveRuntime(), 'CCM Codex native runner');
    const shellInvocation = directShellInvocation({
      platform: 'windows',
      shell: shell || environment.shell,
      command,
      useProfile,
    });
    const profile = permissionProfile === 'workspace-write'
      ? 'workspace-online' : 'read-only';
    return {
      file: executable,
      args: [
        '--workspace-root', root,
        '--codex-home', codexHome,
        '--cwd', workdir,
        '--profile', profile,
        '--', shellInvocation.file, ...shellInvocation.args,
      ],
      sandboxed: true,
      permissionProfile,
      environmentOverrides: { CODEX_HOME: codexHome },
      tty,
    };
  }
}
