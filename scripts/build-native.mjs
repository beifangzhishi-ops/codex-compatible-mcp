import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDir = path.join(root, 'native', 'bin');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + ' exited with code ' + result.status);
  }
}

function findWindowsCsc() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  return [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ].find((candidate) => fs.existsSync(candidate)) || null;
}

function findCargo() {
  const candidates = [
    process.env.CARGO,
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe')
      : null,
    'cargo',
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === 'cargo' || fs.existsSync(candidate));
}

function findVsDevCmd() {
  const base = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(
    base,
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!fs.existsSync(vswhere)) return null;

  const query = spawnSync(vswhere, [
    '-latest',
    '-products',
    '*',
    '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property',
    'installationPath',
  ], { encoding: 'utf8' });

  const installationPath = query.stdout?.trim();
  if (!installationPath) return null;
  const devCmd = path.join(installationPath, 'Common7', 'Tools', 'VsDevCmd.bat');
  return fs.existsSync(devCmd) ? devCmd : null;
}

function buildWindowsSandbox() {
  const csc = findWindowsCsc();
  if (!csc) {
    throw new Error(
      'CCM Windows sandbox build requires the Windows .NET Framework C# compiler.',
    );
  }

  const source = path.join(
    root,
    'native',
    'windows-sandbox',
    'CcmSandboxRunner.cs',
  );
  const output = path.join(outputDir, 'ccm-sandbox-windows.exe');

  run(csc, [
    '/nologo',
    '/optimize+',
    '/target:exe',
    '/out:' + output,
    source,
  ]);
}

function buildPtyProxy() {
  const cargo = findCargo();
  if (!cargo) throw new Error('Rust cargo was not found.');

  const manifest = path.join(root, 'native', 'pty-proxy', 'Cargo.toml');
  const target = path.join(
    root,
    'native',
    'pty-proxy',
    'target',
    'release',
    process.platform === 'win32' ? 'ccm-pty-proxy.exe' : 'ccm-pty-proxy',
  );

  if (process.platform === 'win32') {
    const devCmd = findVsDevCmd();
    if (!devCmd) {
      throw new Error(
        'Visual Studio C++ Build Tools are required to build the CCM Rust PTY proxy.',
      );
    }

    const batchPath = path.join(outputDir, '.build-pty.cmd');
    const batch = [
      '@echo off',
      'call "' + devCmd + '" -no_logo -arch=x64 -host_arch=x64 >nul',
      'if errorlevel 1 exit /b %errorlevel%',
      '"' + cargo + '" build --release --manifest-path "' + manifest + '"',
      'exit /b %errorlevel%',
    ].join('\r\n');
    fs.writeFileSync(batchPath, batch, 'utf8');
    try {
      run('cmd.exe', ['/d', '/c', batchPath]);
    } finally {
      fs.rmSync(batchPath, { force: true });
    }
  } else {
    run(cargo, ['build', '--release', '--manifest-path', manifest]);
  }

  fs.copyFileSync(target, path.join(
    outputDir,
    process.platform === 'win32' ? 'ccm-pty-proxy.exe' : 'ccm-pty-proxy',
  ));
}

fs.mkdirSync(outputDir, { recursive: true });

if (process.platform === 'win32') {
  buildWindowsSandbox();
}
buildPtyProxy();
