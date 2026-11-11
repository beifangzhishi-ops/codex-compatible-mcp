import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = path.join(root, 'native', 'windows-sandbox', 'CcmSandboxRunner.cs');
const enabled = process.platform === 'win32' &&
  process.env.CCM_RUN_WINDOWS_TEMP_ACL_TEST === '1';
const win = (s) => String(s).replaceAll("'", "''");
const quote = (s) => "'" + win(s) + "'";

function execute(file, args, { cwd, env = process.env, timeout = 12000 } = {}) {
  const result = spawnSync(file, args, {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout,
  });
  assert.ifError(result.error);
  return result;
}

test('Windows restricted-token temp writes use final TMP/TEMP without widening read-only',
  { skip: !enabled }, () => {
    const cache = path.join(root, '.cache');
    fs.mkdirSync(cache, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(cache, 'temp-acl-test-'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-native-tmp-'));
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-native-temp-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-native-outside-'));

    try {
      const csc = path.join(process.env.WINDIR || 'C:\\Windows',
        'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      assert.ok(fs.existsSync(csc), 'Windows .NET C# compiler required');
      const runner = path.join(workspace, 'native-sandbox-test.exe');
      const build = execute(csc, [
        '/nologo', '/optimize+', '/target:exe', `/out:${runner}`, source,
      ], { cwd: workspace });
      assert.equal(build.status, 0, build.stderr || build.stdout);

      const baseEnv = { ...process.env };
      for (const key of Object.keys(baseEnv)) {
        if (key.toUpperCase() === 'TEMP' || key.toUpperCase() === 'TMP')
          delete baseEnv[key];
      }
      const environment = { ...baseEnv, TMP: tmp, TEMP: temp };
      function restricted(profile, script, overrides = {}) {
        return execute(runner, [
          '--profile', profile, '--workspace', workspace, '--cwd', workspace,
          '--shell', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
          '--command', script, '--use-profile', 'false',
        ], { cwd: workspace, env: { ...environment, ...overrides } });
      }

      const tmpFile = path.join(tmp, 'sample.txt');
      const tempFile = path.join(temp, 'sample.txt');
      const existingFile = path.join(tmp, 'existing-before-allow.txt');
      fs.writeFileSync(existingFile, 'original');
      const writeBoth = [
        `Set-Content -LiteralPath ${quote(tmpFile)} -Value tmp-ok -ErrorAction Stop`,
        `Set-Content -LiteralPath ${quote(tempFile)} -Value temp-ok -ErrorAction Stop`,
        `Set-Content -LiteralPath ${quote(existingFile)} -Value updated -ErrorAction Stop`,
        'Write-Output BOTH_OK',
      ].join('; ');
      const allowed = restricted('workspace-write', writeBoth);
      assert.equal(allowed.status, 0, allowed.stderr || allowed.stdout);
      assert.match(allowed.stdout, /BOTH_OK/);
      assert.equal(fs.readFileSync(tmpFile, 'utf8').trim(), 'tmp-ok');
      assert.equal(fs.readFileSync(tempFile, 'utf8').trim(), 'temp-ok');
      assert.equal(fs.readFileSync(existingFile, 'utf8').trim(), 'updated');

      const deniedFile = path.join(outside, 'not-allowed.txt');
      const tryWrite = (file) =>
        `try { Set-Content -LiteralPath ${quote(file)} -Value forbidden -ErrorAction Stop; Write-Output WROTE } catch { Write-Output DENIED }`;
      const outsideResult = restricted('workspace-write', tryWrite(deniedFile));
      assert.equal(outsideResult.status, 0, outsideResult.stderr);
      assert.match(outsideResult.stdout, /DENIED/);
      assert.equal(fs.existsSync(deniedFile), false);

      const roFile = path.join(tmp, 'read-only-must-not-write.txt');
      const readOnly = restricted('read-only', tryWrite(roFile));
      assert.equal(readOnly.status, 0, readOnly.stderr);
      assert.match(readOnly.stdout, /DENIED/);
      assert.equal(fs.existsSync(roFile), false);

      const duplicate = restricted('workspace-write',
        `Set-Content -LiteralPath ${quote(path.join(tmp, 'dedup.txt'))} -Value ok -ErrorAction Stop; Write-Output DEDUP_OK`,
        { TEMP: tmp });
      assert.equal(duplicate.status, 0, duplicate.stderr);
      assert.match(duplicate.stdout, /DEDUP_OK/);

      const prohibited = restricted('workspace-write', 'Write-Output MUST_NOT_RUN',
        { TMP: os.homedir() });
      assert.equal(prohibited.status, 125, prohibited.stderr);
      assert.match(prohibited.stderr, /protected directory/);
      assert.doesNotMatch(prohibited.stdout, /MUST_NOT_RUN/);

      const malformed = restricted('workspace-write', 'Write-Output MUST_NOT_RUN',
        { TMP: 'relative\\temp' });
      assert.equal(malformed.status, 125, malformed.stderr);
      assert.match(malformed.stderr, /absolute local directory/);

      const junction = path.join(workspace, 'temp-junction');
      fs.symlinkSync(temp, junction, 'junction');
      const redirected = restricted('workspace-write', 'Write-Output MUST_NOT_RUN',
        { TMP: junction });
      assert.equal(redirected.status, 125, redirected.stderr);
      assert.match(redirected.stderr, /reparse point/);

      const bin = 'C:\\texlive\\2026\\bin\\windows';
      const xelatex = path.join(bin, 'xelatex.exe');
      const xdvipdfmx = path.join(bin, 'xdvipdfmx.exe');
      if (fs.existsSync(xelatex) && fs.existsSync(xdvipdfmx)) {
        fs.writeFileSync(path.join(workspace, 'minimal.tex'),
          '\\documentclass{article}\\begin{document}Temporary write test.\\end{document}');
        const xdv = execute(xelatex, [
          '-no-pdf', '-interaction=nonstopmode', '-halt-on-error', 'minimal.tex',
        ], { cwd: workspace, env: environment, timeout: 30000 });
        assert.equal(xdv.status, 0, xdv.stderr || xdv.stdout);
        const pdf = restricted('workspace-write',
          `& ${quote(xdvipdfmx)} -o minimal.pdf minimal.xdv; exit $LASTEXITCODE`);
        assert.equal(pdf.status, 0, pdf.stderr || pdf.stdout);
        assert.ok(fs.statSync(path.join(workspace, 'minimal.pdf')).size > 0);
      }
    } finally {
      for (const dir of [workspace, tmp, temp, outside])
        fs.rmSync(dir, { recursive: true, force: true });
    }
  });
