import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ExecPolicyStore,
  EXEC_POLICY_STATE_VERSION,
} from '../src/controller/exec-policy-store.mjs';
import {
  hashPackageScript,
  parsePackageScriptCommand,
} from '../src/controller/package-script-policy.mjs';

const workspaceContext = {
  workspace_context: '00000000-0000-4000-8000-000000000001',
  environment_id: 'worker-a',
  workspace_id: 'workspace-a',
  workspace_kind: 'registered',
  workspace_root: 'C:\\workspace',
};
const environment = {
  id: 'worker-a',
  platform: 'windows',
  shell: { path: 'powershell.exe', type: 'powershell' },
};

test('package script commands recognize only explicit script forms and npm test', () => {
  assert.deepEqual(parsePackageScriptCommand('npm test'), {
    package_manager: 'npm',
    script: 'test',
  });
  assert.deepEqual(parsePackageScriptCommand('pnpm run test:unit'), {
    package_manager: 'pnpm',
    script: 'test:unit',
  });
  assert.deepEqual(parsePackageScriptCommand('yarn run lint'), {
    package_manager: 'yarn',
    script: 'lint',
  });
  assert.equal(parsePackageScriptCommand('yarn lint'), null);
  assert.equal(parsePackageScriptCommand('npm install'), null);
  assert.equal(parsePackageScriptCommand('npm ci'), null);
  assert.equal(parsePackageScriptCommand('npm test && whoami'), null);
  assert.equal(parsePackageScriptCommand('npm test -- --watch'), null);
  assert.equal(
    hashPackageScript('node --test').length,
    64,
  );
});

test('workspace prefix rule matches later suffix tokens', () => {
  const store = new ExecPolicyStore();
  const args = {
    cmd: 'wsl.exe --status',
    workdir: null,
    tty: false,
    shell: null,
  };
  const rule = store.allow({
    workspaceContext,
    environment,
    args,
    prefixTokens: ['wsl.exe'],
  });
  const match = store.match({
    workspaceContext,
    environment,
    args: {
      ...args,
      cmd: 'wsl.exe -d PhD-CFD -- bash -lc "rm -f /tmp/x"',
    },
  });
  assert.equal(match?.rule_id, rule.rule_id);
  assert.deepEqual(match?.prefix_tokens, ['wsl.exe']);
});

test('prefix matching is token-based and bound to workspace execution context', () => {
  const store = new ExecPolicyStore();
  const args = {
    cmd: 'git config --get user.name',
    workdir: 'packages/api',
    tty: false,
    shell: null,
  };
  store.allow({
    workspaceContext,
    environment,
    args,
    prefixTokens: ['git', 'config', '--get'],
  });
  assert.ok(store.match({
    workspaceContext,
    environment,
    args: { ...args, cmd: 'git config --get user.email' },
  }));
  assert.equal(store.match({
    workspaceContext,
    environment,
    args: { ...args, cmd: 'git config --global --get user.name' },
  }), null);
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

test('compound commands require every executable segment to match a rule', () => {
  const store = new ExecPolicyStore();
  const args = { cmd: 'wsl.exe --status', workdir: null, tty: false, shell: null };
  store.allow({
    workspaceContext,
    environment,
    args,
    prefixTokens: ['wsl.exe'],
  });
  assert.equal(store.match({
    workspaceContext,
    environment,
    args: { ...args, cmd: 'wsl.exe --status; whoami' },
  }), null);
});

test('rules bind the effective shell, including environment defaults', () => {
  const store = new ExecPolicyStore();
  const args = { cmd: 'wsl.exe --status', shell: null };
  store.allow({
    workspaceContext,
    environment,
    args,
    prefixTokens: ['wsl.exe'],
  });
  assert.ok(store.match({ workspaceContext, environment, args }));
  assert.equal(store.match({
    workspaceContext,
    environment: {
      ...environment,
      shell: { path: 'cmd.exe', type: 'cmd' },
    },
    args,
  }), null);
});

test('version 1 exact-command state is reset rather than migrated', async () => {
  const tempBase = path.join(process.cwd(), '.cache', 'test-tmp');
  await fs.promises.mkdir(tempBase, { recursive: true });
  const root = await fs.promises.mkdtemp(path.join(tempBase, 'ccm-exec-policy-'));
  const stateFile = path.join(root, 'exec-policy.json');
  try {
    await fs.promises.writeFile(stateFile, JSON.stringify({
      version: 1,
      rules: [{
        rule_id: 'old-rule',
        decision: 'allow',
        environment_id: 'worker-a',
        workspace_id: 'workspace-a',
        workspace_root: 'C:\\workspace',
        command: 'wsl.exe --status',
      }],
    }));
    const store = new ExecPolicyStore({ stateFile });
    assert.deepEqual(store.list(), []);
    const parsed = JSON.parse(await fs.promises.readFile(stateFile, 'utf8'));
    assert.equal(parsed.version, EXEC_POLICY_STATE_VERSION);
    assert.deepEqual(parsed.rules, []);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
