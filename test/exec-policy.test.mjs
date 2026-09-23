import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecPolicyStore,
  hashPackageScript,
  parsePackageScriptCommand,
} from '../src/controller/exec-policy-store.mjs';

const workspaceContext = {
  workspace_context: '00000000-0000-4000-8000-000000000001',
  environment_id: 'worker-a',
  workspace_id: 'workspace-a',
  workspace_kind: 'registered',
  workspace_root: 'C:\\workspace',
};
const environment = { id: 'worker-a' };

test('package script commands are recognized only when structurally simple', () => {
  assert.deepEqual(parsePackageScriptCommand('npm test'), {
    package_manager: 'npm',
    script: 'test',
  });
  assert.deepEqual(parsePackageScriptCommand('pnpm run test:unit'), {
    package_manager: 'pnpm',
    script: 'test:unit',
  });
  assert.deepEqual(parsePackageScriptCommand('yarn lint'), {
    package_manager: 'yarn',
    script: 'lint',
  });
  assert.equal(parsePackageScriptCommand('npm test && whoami'), null);
  assert.equal(parsePackageScriptCommand('npm test -- --watch'), null);
});

test('workspace allow rule is invalidated when package script content changes', () => {
  const store = new ExecPolicyStore();
  const args = { cmd: 'npm test', workdir: null, tty: false, shell: null };
  const original = {
    package_manager: 'npm',
    script: 'test',
    script_sha256: hashPackageScript('node --test'),
  };
  const rule = store.allow({
    workspaceContext,
    environment,
    args,
    packageScript: original,
  });
  assert.equal(store.match({
    workspaceContext,
    environment,
    args,
    packageScript: original,
  })?.rule_id, rule.rule_id);
  assert.equal(store.match({
    workspaceContext,
    environment,
    args,
    packageScript: {
      ...original,
      script_sha256: hashPackageScript('node malicious.js'),
    },
  }), null);
});

test('workspace allow rule does not cross workspace or execution context', () => {
  const store = new ExecPolicyStore();
  const args = {
    cmd: 'Write-Output SAFE',
    workdir: 'packages/api',
    tty: false,
    shell: null,
  };
  store.allow({ workspaceContext, environment, args });
  assert.equal(store.match({
    workspaceContext: { ...workspaceContext, workspace_id: 'workspace-b' },
    environment,
    args,
  }), null);
  assert.equal(store.match({
    workspaceContext,
    environment,
    args: { ...args, tty: true },
  }), null);
});
