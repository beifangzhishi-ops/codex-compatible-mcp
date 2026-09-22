import test from 'node:test';
import assert from 'node:assert/strict';
import { EnvironmentRegistry } from '../src/runtime/environment-registry.mjs';

test('workspace-write public environment metadata distinguishes read and write boundaries', () => {
  const registry = new EnvironmentRegistry({ resolvePaths: false });
  registry.register({
    id: 'worker',
    platform: 'windows',
    cwd: 'C:\\work\\project',
    workspaceRoots: ['C:\\work\\project'],
    permissionProfile: 'workspace-write',
  });

  const [environment] = registry.listPublic();
  assert.equal(environment.permission_profile, 'workspace-write');
  assert.deepEqual(environment.filesystem_policy, {
    exec_command_read_scope: 'host-permitted-filesystem',
    exec_command_write_scope: 'workspace-roots-only',
    workspace_roots_role: 'project-and-write-boundary-not-read-boundary',
  });
});
