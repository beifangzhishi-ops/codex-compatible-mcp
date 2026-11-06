// Build the staged CCM-native Codex Windows sandbox from the pinned upstream
// Git submodule. No installed Codex CLI or desktop application is consulted.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const codexRs = path.join(root, 'vendor', 'openai-codex', 'codex-rs');
const windowsManifest = path.join(codexRs, 'Cargo.toml');
const runnerManifest = path.join(root, 'native', 'codex-native-sandbox', 'Cargo.toml');
const outputDir = path.join(root, 'native', 'bin');
const cargo = process.env.CARGO || (process.env.USERPROFILE
  ? path.join(process.env.USERPROFILE, '.cargo', 'bin', 'cargo.exe')
  : 'cargo.exe');

function run(exe, args) {
  const result = spawnSync(exe, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(exe + ' exited with code ' + result.status);
  }
}

function findVsDevCmd() {
  const base = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(base, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) return null;
  const result = spawnSync(vswhere, [
    '-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) return null;
  const candidate = path.join(result.stdout.trim(), 'Common7', 'Tools', 'VsDevCmd.bat');
  return fs.existsSync(candidate) ? candidate : null;
}

function copyArtifact(source, name) {
  if (!fs.existsSync(source)) {
    throw new Error('Upstream Codex native build did not produce ' + source);
  }
  const output = path.join(outputDir, name);
  const temporary = output + '.' + process.pid + '.tmp';
  const previous = output + '.' + process.pid + '.previous';
  fs.copyFileSync(source, temporary);
  let backedUp = false;
  try {
    if (fs.existsSync(output)) {
      fs.renameSync(output, previous);
      backedUp = true;
    }
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (backedUp && !fs.existsSync(output)) {
      fs.renameSync(previous, output);
    }
    throw new Error('Cannot install CCM native sandbox helper ' + output +
      ': ' + error.message);
  }
  if (backedUp) {
    try {
      fs.rmSync(previous, { force: true });
    } catch (error) {
      console.warn('Previous native sandbox image is still in use: ' +
        previous + ' (' + error.message + ')');
    }
  }
}

if (process.platform !== 'win32') {
  throw new Error('The native Codex Elevated Sandbox can only be built on Windows.');
}
if (!fs.existsSync(windowsManifest)) {
  throw new Error(
    'Upstream Codex Windows sandbox source is missing at ' + windowsManifest +
    '. Initialize the pinned vendor/openai-codex Git submodule before building.',
  );
}
if (!fs.existsSync(runnerManifest)) {
  throw new Error('Missing CCM native Codex sandbox transport crate.');
}
const devCmd = findVsDevCmd();
if (!devCmd) throw new Error('Visual Studio C++ Build Tools are required.');
fs.mkdirSync(outputDir, { recursive: true });

const batchPath = path.join(outputDir, '.build-codex-native.cmd');
const batch = [
  '@echo off',
  'call "' + devCmd + '" -no_logo -arch=x64 -host_arch=x64 >nul',
  'if errorlevel 1 exit /b %errorlevel%',
  '"' + cargo + '" build --release --manifest-path "' + windowsManifest +
    '" -p codex-windows-sandbox --bin codex-command-runner --bin codex-windows-sandbox-setup',
  'if errorlevel 1 exit /b %errorlevel%',
  '"' + cargo + '" build --release --manifest-path "' + runnerManifest + '"',
  'exit /b %errorlevel%',
].join('\r\n');
fs.writeFileSync(batchPath, batch, 'utf8');
try {
  run('cmd.exe', ['/d', '/c', batchPath]);
} finally {
  fs.rmSync(batchPath, { force: true });
}
copyArtifact(path.join(codexRs, 'target', 'release', 'codex-command-runner.exe'),
  'codex-command-runner.exe');
copyArtifact(path.join(codexRs, 'target', 'release', 'codex-windows-sandbox-setup.exe'),
  'codex-windows-sandbox-setup.exe');
copyArtifact(path.join(root, 'native', 'codex-native-sandbox', 'target', 'release',
  'ccm-codex-native-sandbox.exe'), 'ccm-codex-native-sandbox.exe');
console.log('CCM-native Codex Windows sandbox built; no external Codex CLI required.');
