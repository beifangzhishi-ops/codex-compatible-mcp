import { AdministratorProcessClient } from '../src/runtime/admin/admin-process-client.mjs';
import { CCM_ROOT } from '../src/runtime/admin/ipc-protocol.mjs';

if (process.platform !== 'win32') {
  throw new Error('CCM administrator agent verification requires Windows.');
}

const script = [
  '$p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
  'if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
  "Write-Output 'CCM_ADMIN_AGENT_ELEVATED'; exit 0",
  '} else { Write-Error "Administrator token unavailable"; exit 12 }',
].join('\n');

const result = await new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error('CCM administrator agent verification timed out.')), 15_000);
  new AdministratorProcessClient().startProcess({
    file: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    cwd: CCM_ROOT,
    env: process.env,
    onData: (chunk) => { output += String(chunk); },
    onExit: (code) => { clearTimeout(timer); resolve({ code, output }); },
  });
});
if (result.code !== 0 || !result.output.includes('CCM_ADMIN_AGENT_ELEVATED')) {
  throw new Error('CCM administrator agent verification failed: ' + result.output.slice(0, 1000));
}
console.log('CCM administrator agent: verified elevated Windows token and local IPC.');
