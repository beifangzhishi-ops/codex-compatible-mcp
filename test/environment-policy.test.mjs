import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';

test('public environment metadata hides internal directories and permission topology', () => {
  const registry = new EnvironmentRegistry({ resolvePaths: false });
  registry.register({
    id: 'worker',
    platform: 'windows',
    cwd: 'C:\\work\\project',
    workspaceRoots: ['C:\\work\\project'],
    permissionProfile: 'workspace-write',
  });

  const [environment] = registry.listPublic();
  assert.equal(environment.id, 'worker');
  assert.equal(environment.platform, 'windows');
  assert.equal(environment.cwd, undefined);
  assert.equal(environment.workspace_roots, undefined);
  assert.equal(environment.permission_profile, undefined);
  assert.equal(environment.filesystem_policy, undefined);

  const internal = registry.resolve('worker');
  assert.equal(internal.cwd, 'C:\\work\\project');
  assert.deepEqual(internal.workspaceRoots, ['C:\\work\\project']);
  assert.equal(internal.permissionProfile, 'workspace-write');
});
