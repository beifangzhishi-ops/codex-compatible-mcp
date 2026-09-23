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
      call: async (_environmentId, method, params = {}) => {
        if (method === 'list_workspaces') return { workspaces: [] };
        if (method === 'get_workspace') {
          return {
            workspace_id: 'project',
            kind: 'registered',
            root: 'C:\\work\\project',
          };
        }
        if (method === 'inspect_workspace_path') {
          return {
            workspace_id: params.workspace_id || 'new-project',
            root: params.path,
            exists: !params.create_if_missing,
            create_required: Boolean(params.create_if_missing),
          };
        }
        throw new Error('unexpected worker method: ' + method);
      },
    },
    processManager: {
      execCommand: async () => ({ wall_time_seconds: 0, output: '', exit_code: 0 }),
      writeStdin: async () => ({ wall_time_seconds: 0, output: '', exit_code: 0 }),
      prepareEscalatedCommand: () => ({
        value: {
          chunk_id: 'approval',
          wall_time_seconds: 0,
          output: 'pending',
          approval_required: true,
          approval_id: '00000000-0000-4000-8000-000000000003',
          operation_id: '00000000-0000-4000-8000-000000000004',
          state: 'pending',
          environment_id: 'primary',
          workspace_context: '00000000-0000-4000-8000-000000000001',
          workspace_id: 'projectless-test',
          workspace_kind: 'projectless',
          workspace_root: 'C:\\temp\\projectless-test',
          command: 'Write-Output elevated',
          workdir: null,
          tty: false,
          shell: null,
          justification: 'test',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          intent_sha256: 'a'.repeat(64),
        },
        approvalNonce: 'n'.repeat(32),
      }),
      resolvePendingExecution: async () => ({
        wall_time_seconds: 0,
        output: '',
        exit_code: 0,
        state: 'consumed',
      }),
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
        create_if_missing: Boolean(intent.create_if_missing),
        justification,
      }),
    },
  };
}

test('core tool surface keeps workspace lifecycle deferred and common operations direct', async () => {
  const registry = registerCoreTools(new ToolRegistry(), runtimeStub());

  const direct = registry.listDirect().map((tool) => tool.name).sort();
  assert.deepEqual(direct, [
    'apply_patch',
    'exec_command',
    'list_environments',
    'request_escalated_exec',
    'resolve_pending_action',
    'respond_to_escalation',
    'view_image',
    'write_stdin',
  ]);
  assert.deepEqual(
    registry.get('resolve_pending_action').mcpMeta.ui.visibility,
    ['app'],
  );

  for (const name of [
    'create_projectless_context',
    'list_workspaces',
    'select_workspace',
    'register_workspace',
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

  const legacyEscalation = await registry.get('exec_command').handler({
    workspace_context: '00000000-0000-4000-8000-000000000001',
    cmd: 'Write-Output elevated',
    sandbox_permissions: 'require_escalated',
  });
  assert.equal(legacyEscalation.isError, true);
  assert.match(legacyEscalation.content[0].text, /request_escalated_exec/);

  const approvalCard = await registry.get('request_escalated_exec').handler({
    workspace_context: '00000000-0000-4000-8000-000000000001',
    cmd: 'Write-Output elevated',
    justification: 'test',
  }, { extra: { _meta: { 'openai/session': 'chat-test' } } });
  assert.equal(approvalCard.structuredContent.state, 'pending');
  assert.equal(
    Object.hasOwn(approvalCard.structuredContent, 'approval_nonce'),
    false,
  );
  assert.equal(typeof approvalCard._meta.approval_nonce, 'string');
  assert.deepEqual(
    Object.keys(registry.get('resolve_pending_action').inputSchema).sort(),
    ['approval_id', 'approval_nonce', 'decision'],
  );

  const { codeModeManager } = registerArchitectureTools(registry);
  try {
    assert.deepEqual(
      registry.listDirect().map((tool) => tool.name).sort(),
      [
        'apply_patch',
        'exec',
        'exec_command',
        'list_environments',
        'request_escalated_exec',
        'resolve_pending_action',
        'respond_to_escalation',
        'tool_search',
        'view_image',
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
    assert.doesNotMatch(pending.justification, /read access/i);

    const register = await registry.get('exec').handler({
      calls: [{
        tool: 'ccm.register_workspace',
        arguments: {
          environment_id: 'noha',
          workspace_id: 'new-project',
          path: 'C:\\work\\new-project',
          create_if_missing: true,
        },
      }],
      yield_time_ms: 1000,
    });
    const registerPending =
      register.structuredContent.calls[0].result.structured_content;
    assert.equal(registerPending.approval_required, true);
    assert.equal(registerPending.create_if_missing, true);
    assert.match(registerPending.justification, /create, register, and enter/i);
  } finally {
    codeModeManager.close();
  }
});
