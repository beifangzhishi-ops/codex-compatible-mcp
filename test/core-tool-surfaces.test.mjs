import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { readCcmConfig } from '../src/runtime/ccm-config.mjs';

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
    workspaceHandleManager: {
      resolve: (handle) => {
        if (handle !== '00000000-0000-4000-8000-000000000009') {
          throw new Error('Unknown or expired workspace_handle');
        }
        return {
          workspace_handle: handle,
          environment_id: 'primary',
          workspace_id: 'project',
          workspace_kind: 'registered',
          workspace_root: 'C:\\work\\project',
        };
      },
      createProjectless: async (environmentId = null) => ({
        workspace_handle: '00000000-0000-4000-8000-000000000001',
        environment_id: environmentId || 'primary',
        workspace_id: 'projectless-test',
        workspace_kind: 'projectless',
        workspace_root: 'C:\\temp\\projectless-test',
      }),
      createRegistered: (environmentId, workspace) => ({
        workspace_handle: '00000000-0000-4000-8000-000000000009',
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
                  projectless_workspaces: [{
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
            workspace_handle: args.workspace_handle,
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
          workspace_handle: '00000000-0000-4000-8000-000000000001',
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

test('list_projects displays optional per-Worker default project directories without changing roots', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ccm-directory-hints-'));
  const configPath = path.join(directory, 'ccm.config.json');
  const examplePath = new URL('../ccm.config.example.json', import.meta.url);
  try {
    const config = readCcmConfig(fileURLToPath(examplePath));
    config.controller.project_directory_hints = {
      primary: 'C:\\Users\\example\\Documents\\ChatGPT',
      noha: 'C:\\Users\\example\\Documents\\AAAVitalFile',
    };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const runtime = runtimeStub();
    runtime.ccmConfigFile = configPath;
    const registry = registerCoreTools(new ToolRegistry(), runtime);
    const listed = (await registry.get('list_projects').handler({})).structuredContent.environments;
    assert.deepEqual(listed.map((env) => env.project_directory_hint), [
      'C:\\Users\\example\\Documents\\ChatGPT',
      'C:\\Users\\example\\Documents\\AAAVitalFile',
    ]);
    assert.equal(listed[0].projects[0].root, 'C:\\work\\primary-project');
    assert.equal((await registry.get('list_projects').handler({ environment_id: 'noha' }))
      .structuredContent.environments[0].project_directory_hint,
    'C:\\Users\\example\\Documents\\AAAVitalFile');

    delete config.controller.project_directory_hints;
    fs.writeFileSync(configPath, JSON.stringify(config));
    const withoutHints = (await registry.get('list_projects').handler({})).structuredContent.environments;
    assert.ok(withoutHints.every((env) => !Object.hasOwn(env, 'project_directory_hint')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('core tool surface returns workspace handles while retaining approval cards', async () => {
  const registry = registerCoreTools(new ToolRegistry(), runtimeStub());

  const direct = registry.list().map((tool) => tool.name).sort();
  assert.deepEqual(direct, [
    'apply_patch',
    'claim_full_access',
    'create_projectless_handle',
    'exec_command',
    'get_approval_status',
    'get_verification_input_status',
    'list_projects',
    'register_workspace',
    'request_approval',
    'request_verification_input',
    'resolve_pending_action',
    'select_workspace',
    'submit_verification_input',
    'unregister_workspace',
    'view_image',
    'write_stdin',
  ]);
  assert.deepEqual(
    registry.get('resolve_pending_action').mcpMeta.ui.visibility,
    ['app'],
  );
  for (const name of ['get_verification_input_status', 'submit_verification_input']) {
    assert.deepEqual(registry.get(name).mcpMeta.ui.visibility, ['app']);
  }
  assert.equal(
    registry.get('request_verification_input').mcpMeta.ui.resourceUri,
    'ui://ccm/verification-input-v1.html',
  );
  assert.match(
    registry.get('list_projects').description,
    /sandbox_read_scope.*sandbox_write_scope/,
  );
  assert.match(
    registry.get('create_projectless_handle').description,
    /absolute paths outside the projectless root/,
  );
  assert.match(
    registry.get('create_projectless_handle').description,
    /Never use it to bypass a pending explicit workspace-entry approval/i,
  );
  assert.match(
    registry.get('create_projectless_handle').description,
    /permitted absolute-path reads/i,
  );
  assert.match(
    registry.get('select_workspace').description,
    /explicitly requested entry\/switch AND there is no usable workspace_handle/i,
  );
  assert.match(
    registry.get('select_workspace').description,
    /Merely inspecting or editing a project is not entry authorization/i,
  );
  assert.match(
    registry.get('select_workspace').description,
    /Never expose a pending\/failed handle, retry the frozen entry, or bypass it/i,
  );
  assert.match(
    registry.get('select_workspace').description,
    /Full Access returns the handle/i,
  );
  assert.match(
    registry.get('register_workspace').description,
    /explicit user registration request AND when no usable handle exists/i,
  );
  assert.match(
    registry.get('register_workspace').description,
    /inspecting or editing alone is not authorization/i,
  );
  assert.match(
    registry.get('exec_command').inputSchema.workspace_handle.description,
    /If user\/project instructions supply one.*reuse it directly/,
  );
  assert.equal(Object.hasOwn(registry.get('exec_command').inputSchema, 'environment_id'), false);
  assert.match(
    registry.get('register_workspace').description,
    /Do not expose pending\/failed handles, retry the frozen action, or bypass it/i,
  );
  assert.match(
    registry.get('register_workspace').description,
    /Full Access returns the handle/i,
  );
  const unregisterTool = registry.get('unregister_workspace');
  assert.match(unregisterTool.description, /Always requires a one-shot CCM approval card/);
  assert.match(
    registry.get('exec_command').description,
    /its read scope follows the Worker, while ordinary writes follow the workspace sandbox/i,
  );
  assert.match(
    registry.get('exec_command').description,
    /Reuse workspace_handle for routing\/cwd and session ownership/i,
  );
  assert.match(
    registry.get('exec_command').description,
    /Native Codex ExecPolicy \.rules decides Allow.*Prompt.*Forbidden/i,
  );
  assert.match(
    registry.get('apply_patch').description,
    /Never select\/register implicitly or bypass pending approval/i,
  );
  assert.match(
    registry.get('view_image').description,
    /do not select\/register a project merely to inspect images/i,
  );

  for (const name of ['list_projects', 'select_workspace', 'register_workspace']) {
    assert.ok(registry.get(name));
  }
  for (const name of ['select_workspace', 'register_workspace']) {
    const tool = registry.get(name);
    assert.equal(tool.mcpMeta?.ui?.resourceUri, undefined, name + ' must not render an empty card before approval');
  }
  assert.match(registry.get('request_verification_input').description, /wait for its automatic code-free follow-up/i);
  assert.match(registry.get('request_verification_input').description, /Do NOT inspect or request the code/i);
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
    Object.hasOwn(projects.structuredContent.environments[0], 'projectless_workspaces'),
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
    allProjects.structuredContent.environments[0].projectless_workspaces[0].projectless_id,
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
      .projectless_workspaces[0].projectless_id,
    'projectless-primary',
  );
  assert.equal(
    Object.hasOwn(
      partialAllProjects.structuredContent.environments[1],
      'projectless_workspaces',
    ),
    false,
  );
  const strictProjects = await partialRegistry.get('list_projects').handler({
    environment_id: 'noha',
  });
  assert.equal(strictProjects.isError, true);
  assert.match(strictProjects.content[0].text, /Unknown Remote Worker method/);

  const created = await registry.get('create_projectless_handle').handler({
    environment_id: 'noha',
  });
  assert.equal(created.structuredContent.environment_id, 'noha');

  const missingContext = await registry.get('exec_command').handler({
    cmd: 'Write-Output should-not-run',
  });
  assert.equal(missingContext.isError, true);
  assert.match(missingContext.content[0].text, /requires workspace_handle/);

  const escalation = await registry.get('exec_command').handler({
    workspace_handle: '00000000-0000-4000-8000-000000000001',
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
  assert.match(
    workspacePending.structuredContent.instruction,
    /remains the user's intended target.*wait for this frozen action to resolve/i,
  );
  assert.match(
    workspacePending.structuredContent.instruction,
    /do not retry the same target.*projectless workspace to bypass it/i,
  );
  assert.match(
    workspacePending.structuredContent.instruction,
    /Changing projects alone does not authorize new entry.*explicit entry\/registration instruction/i,
  );
  assert.equal(workspacePending._meta, undefined);

  assert.ok(registry.list().some((tool) => tool.name === 'claim_full_access'));
  assert.equal((await registry.get('claim_full_access').handler({})).structuredContent.claimed, false);
  const projectless = await registry.get('create_projectless_handle').handler({ environment_id: 'noha' });
  assert.equal(projectless.structuredContent.environment_id, 'noha');
  const nohaProjects = await registry.get('list_projects').handler({ environment_id: 'noha', all: true });
  assert.equal(nohaProjects.structuredContent.environments[0].id, 'noha');
  assert.equal(nohaProjects.structuredContent.environments[0].projectless_workspaces[0].projectless_id, 'projectless-noha');
  const select = await registry.get('select_workspace').handler({ environment_id: 'noha', workspace_id: 'project' });
  assert.equal(select.structuredContent.approval_required, true);
  const register = await registry.get('register_workspace').handler({
    environment_id: 'noha', workspace_id: 'new-project',
    path: 'C:\\work\\new-project', create_if_missing: true,
  });
  assert.equal(register.structuredContent.approval_required, true);
  assert.equal(register.structuredContent.create_if_missing, true);
  assert.match(register.structuredContent.justification, /create, register, and enter/i);
  assert.match(register.structuredContent.instruction,
    /remains the user's intended target.*wait for this frozen action to resolve/i);
});

test('write_stdin supports direct empty polling and interactive input', async () => {
  const runtime = runtimeStub();
  const writeCalls = [];
  runtime.processManager.writeStdin = async (args) => {
    writeCalls.push(structuredClone(args));
    return { wall_time_seconds: 0, output: 'continued', exit_code: 0 };
  };
  const registry = registerCoreTools(new ToolRegistry(), runtime);
  const tool = registry.get('write_stdin');
  const workspace_handle = '00000000-0000-4000-8000-000000000001';
  for (const args of [
    { session_id: 41, workspace_handle },
    { session_id: 41, workspace_handle, chars: '' },
    { session_id: 41, workspace_handle, chars: 'y\n' },
  ]) {
    const result = await tool.handler(args);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.exit_code, 0);
  }
  assert.equal(writeCalls.length, 3);
  assert.equal(writeCalls[1].chars, '');
  assert.equal(writeCalls[2].chars, 'y\n');
});
