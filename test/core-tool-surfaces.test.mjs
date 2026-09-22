import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { registerArchitectureTools } from '../src/tools/architecture-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

function runtimeStub() {
  return {
    environmentRegistry: {
      defaultEnvironmentId: 'primary',
      listPublic: () => [],
      resolve: (id = null) => ({ id: id || 'primary' }),
    },
    workspaceContextManager: {
      createProjectless: async (environmentId = null) => ({
        workspace_context: '00000000-0000-4000-8000-000000000001',
        environment_id: environmentId || 'primary',
        workspace_id: 'projectless-test',
        workspace_kind: 'projectless',
        workspace_root: 'C:\\temp\\projectless-test',
      }),
    },
    workerHub: {
      call: async (_environmentId, method) => {
        if (method === 'list_workspaces') return { workspaces: [] };
        if (method === 'get_workspace') {
          return {
            workspace_id: 'project',
            kind: 'registered',
            root: 'C:\\work\\project',
          };
        }
        throw new Error('unexpected worker method: ' + method);
      },
    },
    processManager: {
      execCommand: async () => ({ wall_time_seconds: 0, output: '', exit_code: 0 }),
      writeStdin: async () => ({ wall_time_seconds: 0, output: '', exit_code: 0 }),
    },
    fileService: {},
    approvalManager: {
      requestWorkspaceAction: (operation, intent, justification) => ({
        approval_id: '00000000-0000-4000-8000-000000000002',
        state: 'pending',
        operation,
        environment_id: intent.environment_id,
        workspace_id: intent.workspace_id,
        workspace_root: intent.workspace_root,
        justification,
      }),
    },
  };
}

test('core tool surface keeps bootstrap direct and workspace management deferred', async () => {
  const registry = registerCoreTools(new ToolRegistry(), runtimeStub());

  const direct = registry.listDirect().map((tool) => tool.name).sort();
  assert.deepEqual(direct, [
    'exec_command',
    'list_environments',
    'respond_to_escalation',
    'write_stdin',
  ]);

  for (const name of [
    'create_projectless_context',
    'list_workspaces',
    'select_workspace',
    'register_workspace',
    'apply_patch',
    'view_image',
  ]) {
    const tool = registry.get(name);
    assert.equal(tool.surfaces.direct, false, name + ' should not be direct');
    assert.equal(tool.surfaces.deferred, true, name + ' should be deferred');
    assert.equal(tool.surfaces.codeMode, true, name + ' should support exec');
  }

  const created = await registry.get('create_projectless_context').handler({
    environment_id: 'noha',
  });
  assert.equal(created.structuredContent.environment_id, 'noha');

  const missingContext = await registry.get('exec_command').handler({
    cmd: 'Write-Output should-not-run',
  });
  assert.equal(missingContext.isError, true);
  assert.match(missingContext.content[0].text, /requires workspace_context/);

  const { codeModeManager } = registerArchitectureTools(registry);
  try {
    assert.deepEqual(
      registry.listDirect().map((tool) => tool.name).sort(),
      [
        'exec',
        'exec_command',
        'list_environments',
        'respond_to_escalation',
        'tool_search',
        'wait',
        'write_stdin',
      ],
    );

    const search = await registry.get('tool_search').handler({
      query: 'projectless context',
      limit: 5,
    });
    assert.ok(
      search.structuredContent.tools.some(
        (tool) => tool.qualified_name === 'ccm.create_projectless_context',
      ),
    );

    const projectless = await registry.get('exec').handler({
      calls: [{
        tool: 'ccm.create_projectless_context',
        arguments: { environment_id: 'noha' },
      }],
      yield_time_ms: 1000,
    });
    assert.equal(
      projectless.structuredContent.calls[0].result.structured_content.environment_id,
      'noha',
    );

    const select = await registry.get('exec').handler({
      calls: [{
        tool: 'ccm.select_workspace',
        arguments: {
          environment_id: 'noha',
          workspace_id: 'project',
        },
      }],
      yield_time_ms: 1000,
    });
    const pending = select.structuredContent.calls[0].result.structured_content;
    assert.equal(pending.approval_required, true);
    assert.match(
      pending.justification,
      /does not change existing read access outside the workspace/,
    );
  } finally {
    codeModeManager.close();
  }
});
