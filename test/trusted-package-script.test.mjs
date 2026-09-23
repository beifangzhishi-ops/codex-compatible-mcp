import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hashPackageScript,
} from '../src/controller/exec-policy-store.mjs';
import { TrustedPackageScriptStore } from '../src/controller/trusted-package-script-store.mjs';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';

const workspaceContext = {
  workspace_context: '00000000-0000-4000-8000-000000000001',
  environment_id: 'worker-a',
  workspace_id: 'workspace-a',
  workspace_kind: 'registered',
  workspace_root: 'C:\workspace',
};
const environment = {
  id: 'worker-a',
  shell: { path: 'powershell.exe', type: 'powershell' },
};
const args = {
  cmd: 'npm test',
  workdir: null,
  tty: false,
  shell: null,
};
const packageScript = {
  package_manager: 'npm',
  script: 'test',
  script_sha256: hashPackageScript('node --test'),
};
const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('trusted package-script store persists workspace and script-hash binding', async () => {
  const tempBase = path.join(repoRoot, '.cache', 'test-tmp');
  await fs.promises.mkdir(tempBase, { recursive: true });
  const root = await fs.promises.mkdtemp(
    path.join(tempBase, 'ccm-trusted-package-'),
  );
  const stateFile = path.join(root, 'trusted-package-scripts.json');
  try {
    const first = new TrustedPackageScriptStore({ stateFile });
    const created = first.trust({
      workspaceContext,
      environment,
      args,
      packageScript,
    });
    first.close();

    const second = new TrustedPackageScriptStore({ stateFile });
    assert.equal(second.mayMatch({
      workspaceContext,
      environment,
      args,
    }), true);
    assert.equal(second.match({
      workspaceContext,
      environment,
      args: { ...args, shell: 'powershell' },
      packageScript,
    })?.rule_id, created.rule_id);
    assert.equal(second.match({
      workspaceContext,
      environment,
      args,
      packageScript: {
        ...packageScript,
        script_sha256: hashPackageScript('node changed.js'),
      },
    }), null);
    assert.equal(second.match({
      workspaceContext: {
        ...workspaceContext,
        workspace_id: 'workspace-b',
      },
      environment,
      args,
      packageScript,
    }), null);
    assert.equal(second.match({
      workspaceContext,
      environment,
      args: { ...args, workdir: 'packages/api' },
      packageScript,
    }), null);
    assert.equal(second.match({
      workspaceContext,
      environment,
      args: { ...args, tty: true },
      packageScript,
    }), null);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('trusted package-script store rejects compound shell commands', () => {
  const store = new TrustedPackageScriptStore();
  assert.throws(
    () => store.trust({
      workspaceContext,
      environment,
      args: { ...args, cmd: 'npm test && whoami' },
      packageScript,
    }),
    /structurally simple/i,
  );
});

test('RemoteProcessManager runs a trusted npm test without approval', async () => {
  const registry = new EnvironmentRegistry({ resolvePaths: false });
  registry.register({
    id: 'worker-a',
    platform: 'windows',
    cwd: 'C:\workspace',
    workspaceRoots: ['C:\workspace'],
    permissionProfile: 'workspace-write',
  });
  const calls = [];
  const workerHub = new EventEmitter();
  workerHub.call = async function call(environmentId, method, params) {
    calls.push({ environmentId, method, params });
    if (calls.length === 1) {
      return {
        chunk_id: 'probe',
        wall_time_seconds: 0.01,
        output: '"node --test"\r\n',
        exit_code: 0,
      };
    }
    return {
      chunk_id: 'exec',
      wall_time_seconds: 0.01,
      output: 'TEST_OK',
      exit_code: 0,
    };
  };
  const store = new TrustedPackageScriptStore();
  const rule = store.trust({
    workspaceContext,
    environment,
    args,
    packageScript,
  });
  const manager = new RemoteProcessManager({
    environmentRegistry: registry,
    workerHub,
    approvalManager: {
      requestExecution() {
        throw new Error('approval must not be requested');
      },
    },
    workspaceContextManager: {
      resolve(value) {
        assert.equal(value, workspaceContext.workspace_context);
        return { ...workspaceContext };
      },
    },
    trustedPackageScriptStore: store,
  });

  try {
    const result = await manager.execCommand({
      workspace_context: workspaceContext.workspace_context,
      cmd: 'npm test',
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.trusted_package_script, true);
    assert.equal(result.trusted_package_script_rule_id, rule.rule_id);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].params.sandbox_permissions, 'use_default');
    assert.equal(calls[1].params.sandbox_permissions, 'approved_escalated');
    assert.equal(Object.hasOwn(calls[1].params, 'approval_id'), false);
    assert.equal(Object.hasOwn(calls[1].params, 'justification'), false);
  } finally {
    await manager.close();
  }
});

test('changed package script no longer uses the trusted full-access path', async () => {
  const registry = new EnvironmentRegistry({ resolvePaths: false });
  registry.register({
    id: 'worker-a',
    platform: 'windows',
    cwd: 'C:\workspace',
    workspaceRoots: ['C:\workspace'],
    permissionProfile: 'workspace-write',
  });
  const calls = [];
  const workerHub = new EventEmitter();
  workerHub.call = async function call(environmentId, method, params) {
    calls.push({ environmentId, method, params });
    if (calls.length === 1) {
      return {
        chunk_id: 'probe',
        wall_time_seconds: 0.01,
        output: '"node changed.js"\r\n',
        exit_code: 0,
      };
    }
    return {
      chunk_id: 'exec',
      wall_time_seconds: 0.01,
      output: 'SANDBOXED',
      exit_code: 0,
    };
  };
  const store = new TrustedPackageScriptStore();
  store.trust({
    workspaceContext,
    environment,
    args,
    packageScript,
  });
  const manager = new RemoteProcessManager({
    environmentRegistry: registry,
    workerHub,
    workspaceContextManager: {
      resolve() {
        return { ...workspaceContext };
      },
    },
    trustedPackageScriptStore: store,
  });

  try {
    const result = await manager.execCommand({
      workspace_context: workspaceContext.workspace_context,
      cmd: 'npm test',
    });
    assert.equal(result.trusted_package_script, undefined);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params.sandbox_permissions, undefined);
  } finally {
    await manager.close();
  }
});
