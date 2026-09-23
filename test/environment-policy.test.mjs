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
  assert.deepEqual(environment.filesystem_access, {
    read_scope: 'host',
    write_scope: 'workspace',
  });

  const internal = registry.resolve('worker');
  assert.equal(internal.cwd, 'C:\\work\\project');
  assert.deepEqual(internal.workspaceRoots, ['C:\\work\\project']);
  assert.equal(internal.permissionProfile, 'workspace-write');
});

test('public filesystem access summary follows the effective permission profile', () => {
  const registry = new EnvironmentRegistry({ resolvePaths: false });
  for (const [id, permissionProfile] of [
    ['ro', 'read-only'],
    ['ww', 'workspace-write'],
    ['full', 'full-access'],
    ['future', 'future-restricted-profile'],
  ]) {
    registry.register({
      id,
      platform: 'windows',
      cwd: 'C:\\work\\' + id,
      workspaceRoots: ['C:\\work\\' + id],
      permissionProfile,
    });
  }

  const byId = Object.fromEntries(
    registry.listPublic().map((environment) => [environment.id, environment]),
  );
  assert.deepEqual(byId.ro.filesystem_access, {
    read_scope: 'host',
    write_scope: 'none',
  });
  assert.deepEqual(byId.ww.filesystem_access, {
    read_scope: 'host',
    write_scope: 'workspace',
  });
  assert.deepEqual(byId.full.filesystem_access, {
    read_scope: 'host',
    write_scope: 'host',
  });
  assert.deepEqual(byId.future.filesystem_access, {
    read_scope: 'restricted',
    write_scope: 'restricted',
  });
});
