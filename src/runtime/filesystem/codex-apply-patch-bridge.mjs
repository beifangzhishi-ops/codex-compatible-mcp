import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const executable = path.join(
  root, 'native', 'bin',
  process.platform === 'win32' ? 'ccm-codex-apply-patch.exe' : 'ccm-codex-apply-patch',
);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 28_000;

function invokeNative(request) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let completed = false;
    let timeout = null;
    const fail = (error) => {
      if (completed) return;
      completed = true;
      if (timeout) clearTimeout(timeout);
      child.kill();
      reject(error);
    };
    timeout = setTimeout(() => {
      fail(new Error('Codex apply_patch native helper timed out; inspect files before retrying.'));
    }, TIMEOUT_MS);
    const collect = (pieces) => (data) => {
      size += data.length;
      if (size > MAX_OUTPUT_BYTES) {
        fail(new Error('Codex apply_patch response exceeded the output limit.'));
      } else {
        pieces.push(data);
      }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', fail);
    child.on('close', (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(
          'Codex apply_patch native helper exited ' + code + ': ' +
          Buffer.concat(stderr).toString('utf8'),
        ));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch {
        reject(new Error('Invalid Codex apply_patch native response.'));
      }
    });
    child.stdin.on('error', (error) => fail(error));
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

export async function applyPatchToEnvironment({ environment, patch, workdir }) {
  if (!environment) throw new Error('environment is required');
  if (typeof patch !== 'string' || patch.length === 0) {
    throw new Error('patch must be a nonempty string');
  }
  const resolvedWorkdir = workdir
    ? path.resolve(environment.cwd, workdir)
    : environment.cwd;
  const result = await invokeNative({
    patch,
    workdir: resolvedWorkdir,
    workspace_roots: environment.workspaceRoots || [],
    profile: environment.permissionProfile || 'workspace-write',
  });
  if (!result.ok) {
    const changed = result.changes?.length
      ? '\nFiles already modified before failure:\n' +
        result.changes.map((change) => change.summary).join('\n')
      : '';
    throw new Error('Codex apply_patch failed: ' + result.error + changed);
  }
  return {
    workdir: resolvedWorkdir,
    changes: result.changes,
    output: result.output,
  };
}
