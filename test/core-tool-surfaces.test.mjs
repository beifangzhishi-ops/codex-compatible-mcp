import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { registerArchitectureTools } from '../src/tools/architecture-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

function runtimeStub() {
  return {
    environmentRegistry: {
      defaultEnvironmentId: 'primary',
      listPublic: () => [
        {
          id: 'primary',
          name: 'primary',
          platform: 'windows',
          shell: { type: 'powershell', path: 'powershell.exe' },
          capabilities: { exec: true },
          sandbox_read_scope: 'host',
          sandbox_write_scope: 'context_root',
          backend: 'remote-worker',
          is_default: true,
        },
        {
          id: 'noha',
          name: 'noha',
          platform: 'windows',
          shell: { type: 'powershell', path: 'powershell.exe' },
          capabilities: { exec: true },
          sandbox_read_scope: 'host',
          sandbox_write_scope: 'context_root',
          backend: 'remote-worker',
          is_default: false,
        },
      ],
      resolve: (id = null) => {
        const resolved = id || 'primary';
        if (!['primary', 'noha'].includes(resolved)) {
          throw new Error('Unknown environment: ' + resolved);
        }
        return { id: resolved };
      },
    },
    workspaceContextManager: {
      createProjectless: async (environmentId = null) => ({
        workspace_context: '00000000-0000-4000-8000-000000000001',
        environment_id: environmentId || 'primary',
        workspace_id: 'projectless-test',
        workspace_kind: 'projectless',
        workspace_root: 'C:\\temp\\projectless-test',
      }),
      createRegistered: (environmentId, workspace) => ({
        workspace_context: '00000000-0000-4000-8000-000000000009',
        environment_id: environmentId,
        workspace_id: workspace.workspace_id,
        workspace_kind: 'registered',
        workspace_root: workspace.root,
      }),
    },
    workerHub: {
      call: async (environmentId, method, params = {}) => {
        if (method === 'list_projects') {
          return {
            projects: [{
              project_id: environmentId + '-project',
              root: 'C:\\work\\' + environmentId + '-project',
              created_at: '2026-09-24T00:00:00.000Z',
            }],
            ...(params.all
              ? {
                  projectless_contexts: [{
                    projectless_id: 'projectless-' + environmentId,
                    root: 'C:\\temp\\' + environmentId,
                    created_at: '2026-09-24T00:00:00.000Z',
                  }],
                }
              : {}),
          };
        }
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
        if (method === 'register_workspace') {
          return {
            workspace_id: params.workspace_id,
            kind: 'registered',
            root: params.path,
          };
        }
        throw new Error('unexpected worker method: ' + method);
      },
    },
    processManager: {
      execCommand: async (args) => args.sandbox_permissions === 'require_escalated'
        ? ({
            chunk_id: 'approval',
            wall_time_seconds: 0,
            output: 'Approval required before this command can run outside the sandbox.',
            approval_required: true,
            approval_id: '00000000-0000-4000-8000-000000000003',
            operation_id: '00000000-0000-4000-8000-000000000004',
            kind: 'execution',
            state: 'pending',
            environment_id: 'primary',
            workspace_context: args.workspace_context,
            workspace_id: 'projectless-test',
            workspace_kind: 'projectless',
            workspace_root: 'C:\\temp\\projectless-test',
            command: args.cmd,
            workdir: null,
            tty: false,
            shell: null,
            justification: args.justification || 'test',
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            intent_sha256: 'a'.repeat(64),
          })
        : ({ wall_time_seconds: 0, output: '', exit_code: 0 }),
      writeStdin: async () => ({ wall_time_seconds: 0, output: '', exit_code: 0 }),
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
          operation_id: '00000000-0000-4000-8000-000000000005',
          state: 'pending',
          kind: 'workspace',
          operation,
          environment_id: intent.environment_id,
          workspace_id: intent.workspace_id,
          workspace_root: intent.workspace_root,
          create_if_missing: Boolean(intent.create_if_missing),
          justification,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          intent_sha256: 'b'.repeat(64),
      }),
      prepareAppApproval: () => ({
        request: {
          approval_id: '00000000-0000-4000-8000-000000000003',
          operation_id: '00000000-0000-4000-8000-000000000004',
          state: 'pending',
          kind: 'execution',
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
    },
  };
}

test('core tool surface keeps workspace lifecycle deferred and centralizes approval cards', async () => {
  const registry = registerCoreTools(new ToolRegistry(), runtimeStub());

  const direct = registry.listDirect().map((tool) => tool.name).sort();
  assert.deepEqual(direct, [
    'apply_patch',
    'exec_command',
    'list_projects',
    'request_approval',
    'resolve_pending_action',
    'view_image',
    'write_stdin',
  ]);
  assert.deepEqual(
    registry.get('resolve_pending_action').mcpMeta.ui.visibility,
    ['app'],
  );
  assert.match(
    registry.get('list_projects').description,
    /sandbox_read_scope.*sandbox_write_scope/,
  );
  assert.equal(registry.get('list_projects').surfaces.direct, true);
  assert.equal(registry.get('list_projects').surfaces.deferred, false);
  assert.equal(registry.get('list_projects').surfaces.codeMode, true);
  assert.match(
    registry.get('create_projectless_context').description,
    /absolute paths outside the projectless root/,
  );
  assert.match(
    registry.get('select_workspace').description,
    /Do not select a workspace merely to read or search/,
  );
  assert.match(
    registry.get('register_workspace').description,
    /Do not register a directory merely to gain read access/,
  );
  assert.match(
    registry.get('exec_command').description,
    /does not narrow filesystem reads below the environment's sandbox_read_scope/,
  );

  for (const name of [
    'create_projectless_context',
    'select_workspace',
    'register_workspace',
  ]) {
    const tool = registry.get(name);
    assert.equal(tool.surfaces.direct, false, name + ' should not be direct');
    assert.equal(tool.surfaces.deferred, true, name + ' should be deferred');
    assert.equal(tool.surfaces.codeMode, true, name + ' should support exec');
  }
  assert.deepEqual(
    Object.keys(registry.get('request_approval').inputSchema),
    ['approval_id'],
  );

  const projects = await registry.get('list_projects').handler({});
  assert.equal(projects.structuredContent.default_environment_id, 'primary');
  assert.deepEqual(
    projects.structuredContent.environments.map((environment) => environment.id),
    ['primary', 'noha'],
  );
  assert.equal(projects.structuredContent.environments[0].projects[0].project_id, 'primary-project');
  assert.equal(
    Object.hasOwn(projects.structuredContent.environments[0], 'projectless_contexts'),
    false,
  );
  assert.equal(projects.structuredContent.environments[0].sandbox_read_scope, 'host');
  assert.equal(projects.structuredContent.environments[0].sandbox_write_scope, 'context_root');

  const filteredProjects = await registry.get('list_projects').handler({
    environment_id: 'noha',
  });
  assert.deepEqual(
    filteredProjects.structuredContent.environments.map((environment) => environment.id),
    ['noha'],
  );

  const allProjects = await registry.get('list_projects').handler({ all: true });
  assert.equal(
    allProjects.structuredContent.environments[0].projectless_contexts[0].projectless_id,
    'projectless-primary',
  );

  const partialRuntime = runtimeStub();
  const abnormal = new Map();
  const originalCall = partialRuntime.workerHub.call;
  partialRuntime.workerHub.environmentStatus = (environmentId) =>
    abnormal.get(environmentId) || { state: 'normal' };
  partialRuntime.workerHub.quarantine = (environmentId, code, reason) => {
    abnormal.set(environmentId, {
      state: 'abnormal',
      abnormal_code: code,
      abnormal_reason: reason,
    });
    return true;
  };
  partialRuntime.workerHub.call = async (environmentId, method, params) => {
    if (environmentId === 'noha' && method === 'list_projects') {
      throw new Error('Unknown Remote Worker method: list_projects');
    }
    return originalCall(environmentId, method, params);
  };
  const partialRegistry = registerCoreTools(new ToolRegistry(), partialRuntime);
  const partialProjects = await partialRegistry.get('list_projects').handler({});
  assert.equal(partialProjects.isError, undefined);
  assert.equal(
    partialProjects.structuredContent.environments[0].projects[0].project_id,
    'primary-project',
  );
  assert.equal(partialProjects.structuredContent.environments[1].state, 'abnormal');
  assert.equal(
    partialProjects.structuredContent.environments[1].abnormal_code,
    'project_discovery_failed',
  );
  assert.match(
    partialProjects.structuredContent.environments[1].project_discovery_error,
    /Unknown Remote Worker method/,
  );
  assert.equal(
    Object.hasOwn(partialProjects.structuredContent.environments[1], 'projects'),
    false,
  );
  const partialAllProjects = await partialRegistry.get('list_projects').handler({
    all: true,
  });
  assert.equal(
    partialAllProjects.structuredContent.environments[0]
      .projectless_contexts[0].projectless_id,
    'projectless-primary',
  );
  assert.equal(
    Object.hasOwn(
      partialAllProjects.structuredContent.environments[1],
      'projectless_contexts',
    ),
    false,
  );
  const strictProjects = await partialRegistry.get('list_projects').handler({
    environment_id: 'noha',
  });
  assert.equal(strictProjects.isError, true);
  assert.match(strictProjects.content[0].text, /Unknown Remote Worker method/);

  const created = await registry.get('create_projectless_context').handler({
    environment_id: 'noha',
  });
  assert.equal(created.structuredContent.environment_id, 'noha');

  const missingContext = await registry.get('exec_command').handler({
    cmd: 'Write-Output should-not-run',
  });
  assert.equal(missingContext.isError, true);
  assert.match(missingContext.content[0].text, /requires workspace_context/);

  const escalation = await registry.get('exec_command').handler({
    workspace_context: '00000000-0000-4000-8000-000000000001',
    cmd: 'Write-Output elevated',
    sandbox_permissions: 'require_escalated',
  });
  assert.equal(escalation.structuredContent.approval_required, true);
  assert.match(escalation.content[0].text, /request_approval/);

  const approvalCard = await registry.get('request_approval').handler({
    approval_id: '00000000-0000-4000-8000-000000000003',
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

  const workspacePending = await registry.get('select_workspace').handler({
    environment_id: 'noha',
    workspace_id: 'project',
  });
  assert.equal(workspacePending.structuredContent.kind, 'workspace');
  assert.equal(workspacePending.structuredContent.operation, 'select_workspace');
  assert.equal(workspacePending.structuredContent.approval_required, true);
  assert.equal(workspacePending._meta, undefined);

  const { codeModeManager } = registerArchitectureTools(registry);
  try {
    assert.deepEqual(
      registry.listDirect().map((tool) => tool.name).sort(),
      [
        'apply_patch',
        'exec',
        'exec_command',
        'list_projects',
        'request_approval',
        'resolve_pending_action',
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

    const nestedProjects = await registry.get('exec').handler({
      calls: [{
        tool: 'list_projects',
        arguments: { environment_id: 'noha', all: true },
      }],
      yield_time_ms: 1000,
    });
    const nestedProjectResult =
      nestedProjects.structuredContent.calls[0].result.structured_content;
    assert.equal(nestedProjectResult.environments[0].id, 'noha');
    assert.equal(
      nestedProjectResult.environments[0].projectless_contexts[0].projectless_id,
      'projectless-noha',
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
