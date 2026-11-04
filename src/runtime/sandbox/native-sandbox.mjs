import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_HELPER_PATH = fileURLToPath(
  new URL('../../../native/bin/ccm-sandbox-windows.exe', import.meta.url),
);

function detectShellType(shellPath, platform) {
  const name = path.basename(shellPath).toLowerCase();
  if (name === 'cmd' || name === 'cmd.exe') return 'cmd';
  if (name.includes('powershell') || name === 'pwsh' || name === 'pwsh.exe') {
    return 'powershell';
  }
  if (name.includes('bash')) return 'bash';
  if (name.includes('zsh')) return 'zsh';
  if (name === 'sh') return 'sh';
  return platform === 'windows' ? 'powershell' : 'bash';
}

function directShellInvocation({ platform, shell, command }) {
  const selected = shell?.path ||
    (platform === 'windows' ? 'powershell.exe' : '/bin/bash');
  const shellType = shell?.type || detectShellType(selected, platform);

  if (platform === 'windows' && shellType === 'cmd') {
    return { file: selected, args: ['/d', '/s', '/c', command] };
  }
  if (platform === 'windows') {
    return {
      file: selected,
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    };
  }
  return { file: selected, args: ['-lc', command] };
}

export class NativeSandboxBackend {
  constructor({ windowsHelperPath = WINDOWS_HELPER_PATH } = {}) {
    this.windowsHelperPath = windowsHelperPath;
  }

  buildInvocation({
    environment,
    command,
    cwd,
    shell,
    permissionProfile,
  }) {
    if (permissionProfile === 'full-access') {
      return {
        ...directShellInvocation({
          platform: environment.platform,
          shell: shell || environment.shell,
          command,
        }),
        sandboxed: false,
        permissionProfile,
      };
    }

    if (!['read-only', 'workspace-write'].includes(permissionProfile)) {
      throw new Error('Unsupported CCM permission profile: ' + permissionProfile);
    }
    if (environment.platform !== 'windows') {
      throw new Error(
        'Native sandbox for ' + environment.platform +
        ' is not implemented yet; refusing to run unsandboxed.',
      );
    }
    if (!fs.existsSync(this.windowsHelperPath)) {
      throw new Error(
        'CCM Windows sandbox helper is missing. Run "npm run build:native" before using restricted profiles.',
      );
    }

    const selectedShell = shell?.path || environment.shell?.path || 'powershell.exe';
    const workspace = environment.workspaceRoots?.[0] || environment.cwd;

    return {
      file: this.windowsHelperPath,
      args: [
        '--profile',
        permissionProfile,
        '--workspace',
        workspace,
        '--cwd',
        cwd,
        '--shell',
        selectedShell,
        '--command',
        command,
      ],
      sandboxed: true,
      permissionProfile,
    };
  }
}
