// This test exercises the actual CCM ProcessManager and the pinned upstream
// Codex Elevated Sandbox from an elevated Windows test process. It provisions
// the machine-local Codex home and uses only disposable fixture files.
// Ordinary CI skips it because Windows user/ACL provisioning is a host action.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerRuntime } from '../src/runtime/index.mjs';

const enabled = process.platform === 'win32' &&
  process.env.CCM_RUN_CODEX_ELEVATED_INTEGRATION === '1';

test('CCM ProcessManager executes via native CodexSandboxOnline and blocks ordinary outside writes', {
  skip: !enabled && 'requires explicit elevated Windows integration run',
}, async (t) => {
  const root = path.dirname(fileURLToPath(new URL('../', import.meta.url)));
  const cache = path.join(root, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(cache, 'codex-exec-integration-'));
  const workspace = path.join(fixture, 'workspace');
  const outside = path.join(fixture, 'important.txt');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(outside, 'IMPORTANT', 'utf8');
  const runtime = createWorkerRuntime({
    codexSandbox: true,
    environment: {
      id: 'codex-exec-integration', cwd: workspace,
      permissionProfile: 'workspace-write',
    },
    workspaceStateFile: null,
    seedBootstrapWorkspace: false,
  });
  try {
    const quotedOutside = outside.replaceAll("'", "''");
    const cmd = [
      "$ErrorActionPreference='Stop'",
      "Set-Content -LiteralPath 'inside.txt' -Value OK",
      "Write-Output 'INSIDE_OK'",
      "try { Set-Content -LiteralPath '" + quotedOutside + "' -Value WRONG -ErrorAction Stop; Write-Output OUTSIDE_WRITTEN } catch { Write-Output OUTSIDE_DENIED }",
      'whoami /user',
    ].join('; ');
    let result = await runtime.processManager.execCommand({
      cmd, yield_time_ms: 5000,
    });
    let output = result.output;
    for (let i = 0; result.session_id != null && i < 24; i++) {
      result = await runtime.processManager.writeStdin({
        session_id: result.session_id, chars: '', yield_time_ms: 5000,
      });
      output += result.output;
    }
    t.diagnostic('exit=' + result.exit_code + ' output=' + output.slice(0, 2200));
    assert.equal(result.exit_code, 0, 'native Codex did not exit successfully');
    assert.match(output, /INSIDE_OK/);
    assert.match(output, /OUTSIDE_DENIED/);
    assert.match(output.toLowerCase(), /codexsandboxonline/);
    assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8').trim(), 'OK');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'IMPORTANT');
  } finally {
    runtime.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
