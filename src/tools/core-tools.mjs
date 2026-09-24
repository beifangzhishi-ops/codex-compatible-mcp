import * as z from 'zod/v4';
import { APPROVAL_UI_URI } from '../ui/approval-app.mjs';

const UNIFIED_EXEC_OUTPUT_SCHEMA = {
  chunk_id: z.string().optional(),
  wall_time_seconds: z.number(),
  exit_code: z.number().int().optional(),
  session_id: z.number().int().optional(),
  original_token_count: z.number().int().optional(),
  output: z.string(),
  approval_required: z.boolean().optional(),
  approval_id: z.string().optional(),
  operation_id: z.string().optional(),
  kind: z.enum(['execution', 'workspace']).optional(),
  operation: z.enum(['select_workspace', 'register_workspace']).optional(),
  state: z.enum([
    'pending',
    'approved',
    'denied',
    'dispatching',
    'approved_retryable',
    'execution_unknown',
    'consumed',
  ]).optional(),
  environment_id: z.string().optional(),
  command: z.string().optional(),
  workdir: z.string().nullable().optional(),
  tty: z.boolean().optional(),
  shell: z.string().nullable().optional(),
  justification: z.string().optional(),
  expires_at: z.string().optional(),
  intent_sha256: z.string().optional(),
  workspace_context: z.string().optional(),
  workspace_id: z.string().optional(),
  workspace_kind: z.enum(['registered', 'projectless']).optional(),
  workspace_root: z.string().optional(),
  create_if_missing: z.boolean().optional(),
  created_at: z.string().optional(),
  policy_auto_approved: z.boolean().optional(),
  policy_saved: z.boolean().optional(),
  policy_rule_id: z.string().optional(),
  policy_rule_ids: z.array(z.string()).optional(),
  policy_prefix_tokens: z.union([
    z.array(z.string()),
    z.array(z.array(z.string())),
  ]).optional(),
  policy_persistable: z.boolean().optional(),
  policy_kind: z.enum(['prefix', 'package_script']).nullable().optional(),
  prefix_rule: z.array(z.string()).nullable().optional(),
  policy_save_failed: z.boolean().optional(),
  policy_save_error: z.string().optional(),
  trusted_node_test: z.boolean().optional(),
  trusted_package_script: z.boolean().optional(),
  trusted_package_script_rule_id: z.string().optional(),
  action_failed: z.boolean().optional(),
};

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function execResult(value) {
  const lines = [];
  if (value.approval_required) {
    lines.push('Approval required: yes');
    lines.push('Approval ID: ' + value.approval_id);
    lines.push('Environment: ' + value.environment_id);
    lines.push('Command: ' + value.command);
    lines.push('Permission: full-access for this execution only');
    if (value.policy_persistable && Array.isArray(value.prefix_rule)) {
      lines.push('Persistent prefix: ' + value.prefix_rule.join(' '));
    }
    lines.push('Expires: ' + value.expires_at);
    lines.push('Justification: ' + value.justification);
    lines.push(
      'Call the top-level request_approval tool with this approval_id to render the CCM approval card. ' +
      'Do not recreate or retry the command yourself.',
    );
  }
  if (value.chunk_id) lines.push(`Chunk ID: ${value.chunk_id}`);
  if (value.workspace_context) {
    lines.push(`Workspace context: ${value.workspace_context}`);
    lines.push(`Workspace: ${value.environment_id} / ${value.workspace_id}`);
    lines.push(`Workspace kind: ${value.workspace_kind}`);
  }
  lines.push(`Wall time: ${value.wall_time_seconds.toFixed(4)} seconds`);
  if (value.exit_code !== undefined) lines.push(`Process exited with code ${value.exit_code}`);
  if (value.session_id !== undefined) lines.push(`Process running with session ID ${value.session_id}`);
  if (value.original_token_count !== undefined) lines.push(`Original token count: ${value.original_token_count}`);
  lines.push('Output:');
  if (value.output) lines.push(value.output);
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: value,
  };
}

function approvalCardResult(prepared) {
  const value = prepared.value;
  if (prepared.autoApproved) {
    const trustedPackageScript = Boolean(value.trusted_package_script);
    return {
      content: [{
        type: 'text',
        text: [
          trustedPackageScript
            ? 'CCM executed this command through a trusted package-script rule.'
            : 'CCM executed this full-access command under an existing workspace policy.',
          'Environment: ' + value.environment_id,
          'Workspace: ' + value.workspace_id,
          'Command: ' + value.command,
          (trustedPackageScript ? 'Trust rule: ' : 'Policy rule: ') +
            (trustedPackageScript
              ? value.trusted_package_script_rule_id
              : value.policy_rule_id),
          'No additional user approval was required.',
        ].join('\n'),
      }],
      structuredContent: value,
      _meta: {
        source: trustedPackageScript
          ? 'ccm.trusted-package-script'
          : 'ccm.exec-policy',
      },
    };
  }
  const workspaceAction = value.kind === 'workspace';
  const lines = [
    workspaceAction
      ? 'CCM prepared a frozen workspace action for user approval.'
      : 'CCM prepared a frozen full-access command for user approval.',
    'Approval ID: ' + value.approval_id,
    'Operation ID: ' + value.operation_id,
    'Environment: ' + value.environment_id,
    'Workspace: ' + value.workspace_id,
    ...(workspaceAction
      ? [
          'Workspace root: ' + value.workspace_root,
          'Action: ' + value.operation,
        ]
      : ['Command: ' + value.command]),
    'Expires: ' + value.expires_at,
    'The attached CCM approval card is the only valid approval path for this request.',
    workspaceAction
      ? 'Do not recreate or retry this workspace action yourself.'
      : 'Do not recreate or retry this command yourself.',
  ];
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: value,
    _meta: {
      source: 'ccm.approval',
      approval_nonce: prepared.approvalNonce,
    },
  };
}

function workspaceActionStatus(request, {
  output,
  workspaceContext = null,
  actionFailed = false,
} = {}) {
  return {
    wall_time_seconds: 0,
    output: String(output || ''),
    ...request,
    ...(workspaceContext || {}),
    ...(actionFailed ? { action_failed: true } : {}),
  };
}

async function executeWorkspaceAction(runtime, action, {
  requireFullAccess = false,
} = {}) {
  const environment = runtime.environmentRegistry.resolve(
    action.environment_id,
  );
  if (requireFullAccess && environment.permissionProfile !== 'full-access') {
    throw new Error(
      'Environment is no longer full-access; retry the workspace action.',
    );
  }
  let workspace;
  if (action.operation === 'select_workspace') {
    workspace = await runtime.workerHub.call(
      environment.id,
      'get_workspace',
      { workspace_id: action.workspace_id },
      { timeoutMs: 10_000 },
    );
    if (workspace.kind !== 'registered' ||
        workspace.workspace_id !== action.workspace_id ||
        workspace.root !== action.workspace_root) {
      throw new Error(
        'Workspace identity no longer matches the registered workspace.',
      );
    }
  } else if (action.operation === 'register_workspace') {
    const inspected = await runtime.workerHub.call(
      environment.id,
      'inspect_workspace_path',
      {
        path: action.workspace_root,
        workspace_id: action.workspace_id,
        create_if_missing: Boolean(action.create_if_missing),
      },
      { timeoutMs: 10_000 },
    );
    if (inspected.workspace_id !== action.workspace_id ||
        inspected.root !== action.workspace_root) {
      throw new Error(
        'Workspace registration target no longer matches the inspected path.',
      );
    }
    workspace = await runtime.workerHub.call(
      environment.id,
      'register_workspace',
      {
        path: action.workspace_root,
        workspace_id: action.workspace_id,
        create_if_missing: Boolean(action.create_if_missing),
        approved_root: action.workspace_root,
      },
      { timeoutMs: 10_000 },
    );
    if (workspace.workspace_id !== action.workspace_id ||
        workspace.root !== action.workspace_root) {
      throw new Error(
        'Registered workspace no longer matches the requested target.',
      );
    }
  } else {
    throw new Error('Unknown workspace operation: ' + action.operation);
  }

  return runtime.workspaceContextManager.createRegistered(
    environment.id,
    workspace,
  );
}

async function resolvePendingWorkspaceAction(
  runtime,
  { approval_id: approvalId, approval_nonce: approvalNonce, decision },
  { hostSession = null } = {},
) {
  if (decision === 'approve_workspace') {
    throw new Error(
      'Always allow in workspace is only available for execution approvals.',
    );
  }
  if (decision === 'deny') {
    const denied = runtime.approvalManager.denyAppWorkspace(
      approvalId,
      approvalNonce,
      hostSession,
    );
    return workspaceActionStatus(denied, {
      output: 'The user denied this workspace action. No workspace change was made.',
    });
  }
  if (decision !== 'approve') {
    throw new Error('Workspace approval decision must be approve or deny.');
  }

  const claimed = runtime.approvalManager.claimAppWorkspace(
    approvalId,
    approvalNonce,
    hostSession,
  );
  const action = claimed.action;
  try {
    const workspaceContext = await executeWorkspaceAction(runtime, action);
    const consumed = runtime.approvalManager.markAppWorkspaceConsumed(
      approvalId,
    );
    return workspaceActionStatus(consumed, {
      workspaceContext,
      output: action.operation === 'select_workspace'
        ? 'Approved and entered the selected workspace.'
        : 'Approved, registered, and entered the workspace.',
    });
  } catch (error) {
    let consumed = claimed.request;
    try {
      consumed = runtime.approvalManager.markAppWorkspaceConsumed(approvalId);
    } catch {}
    return workspaceActionStatus(consumed, {
      output:
        'Workspace action was not performed: ' +
        String(error?.message || error),
      actionFailed: true,
    });
  }
}

function patchResult(value) {
  return {
    content: [{ type: 'text', text: value.output }],
    structuredContent: {
      workdir: value.workdir,
      changes: value.changes,
      ...(value.workspace_context ? {
        workspace_context: value.workspace_context,
        environment_id: value.environment_id,
        workspace_id: value.workspace_id,
        workspace_kind: value.workspace_kind,
        workspace_root: value.workspace_root,
      } : {}),
    },
  };
}

function imageResult(value) {
  return {
    content: [{
      type: 'image',
      data: value.data,
      mimeType: value.mime_type,
    }],
    _meta: {
      path: value.path,
      mime_type: value.mime_type,
      width: value.width,
      height: value.height,
      byte_length: value.byte_length,
      ...(value.workspace_context ? {
        workspace_context: value.workspace_context,
        environment_id: value.environment_id,
        workspace_id: value.workspace_id,
        workspace_kind: value.workspace_kind,
        workspace_root: value.workspace_root,
      } : {}),
    },
  };
}

function toolError(error) {
  return {
    content: [{ type: 'text', text: String(error?.message || error) }],
    isError: true,
  };
}

export function registerCoreTools(registry, runtime) {
  registry.register({
    name: 'list_projects',
    provider: 'ccm-core',
    surfaces: { direct: true, codeMode: true },
    tags: ['project', 'environment', 'worker', 'capabilities'],
    supportsParallel: true,
    description: [
      'List connected CCM environments and their registered projects without entering a project.',
      'With no environment_id, returns every connected environment. Pass environment_id to restrict discovery to one environment.',
      'Registered projects are returned by default. Set all=true only when existing projectless contexts also need to be inspected.',
      'Discovery is isolated per environment: an abnormal or stale Worker is reported on that environment without blocking healthy Workers. Explicit environment_id calls remain strict.',
      'Each environment includes platform/shell metadata, capabilities, independent effective sandbox_read_scope and sandbox_write_scope values, backend, and default selection. Internal bootstrap directories, raw permission profiles, and filesystem permission topology are intentionally not exposed.',
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().optional().describe('Optional environment id. Omit to list projects across every connected environment.'),
      all: z.boolean().optional().describe('Include existing projectless contexts in a separate projectless_contexts collection. Defaults to false.'),
    },
    handler: async (args) => {
      try {
        const publicEnvironments = runtime.environmentRegistry.listPublic();
        let environments = publicEnvironments;
        if (args.environment_id) {
          runtime.environmentRegistry.resolve(args.environment_id);
          environments = publicEnvironments.filter(
            (environment) => environment.id === args.environment_id,
          );
        }
        const includeAll = Boolean(args.all);
        const discover = async (environment) => {
          const currentStatus = runtime.workerHub.environmentStatus?.(
            environment.id,
          ) || { state: 'normal' };
          if (currentStatus.state === 'abnormal') {
            const error = new Error(
              currentStatus.abnormal_reason ||
              'Remote Worker is quarantined.',
            );
            error.code = 'worker_quarantined';
            if (args.environment_id) throw error;
            return { ...environment, ...currentStatus };
          }

          try {
            const result = await runtime.workerHub.call(
              environment.id,
              'list_projects',
              { all: includeAll },
              { timeoutMs: 10_000 },
            );
            return {
              ...environment,
              state: 'normal',
              projects: result.projects || [],
              ...(includeAll
                ? { projectless_contexts: result.projectless_contexts || [] }
                : {}),
            };
          } catch (error) {
            runtime.workerHub.quarantine?.(
              environment.id,
              error?.code || 'project_discovery_failed',
              String(error?.message || error),
            );
            if (args.environment_id) throw error;
            const failedStatus = runtime.workerHub.environmentStatus?.(
              environment.id,
            ) || {
              state: 'abnormal',
              abnormal_code: error?.code || 'project_discovery_failed',
              abnormal_reason: String(error?.message || error),
            };
            return {
              ...environment,
              ...failedStatus,
              project_discovery_error: String(error?.message || error),
            };
          }
        };
        const enriched = await Promise.all(environments.map(discover));
        return jsonResult({
          default_environment_id: runtime.environmentRegistry.defaultEnvironmentId,
          environments: enriched,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'create_projectless_context',
    provider: 'ccm-core',
    surfaces: { deferred: true, codeMode: true },
    tags: ['workspace', 'projectless', 'context', 'environment'],
    supportsParallel: true,
    description: [
      'Create a projectless workspace_context for operations that do not belong to a registered project.',
      'Use this when no project has been selected. If environment_id is omitted, CCM uses the primary environment.',
      'The returned workspace_context supplies Worker routing and the context root for subsequent CCM operations. Read-scope decisions, including whether absolute paths outside the projectless root are readable, belong to list_projects and exec_command rather than this lifecycle tool.',
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().optional().describe('Environment on which to create the projectless context. Omit to use the primary environment.'),
    },
    handler: async (args) => {
      try {
        if (!runtime.workspaceContextManager) {
          throw new Error('Workspace context manager is not available.');
        }
        return jsonResult(
          await runtime.workspaceContextManager.createProjectless(args.environment_id),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'select_workspace',
    provider: 'ccm-core',
    surfaces: { deferred: true, codeMode: true },
    tags: ['workspace', 'project', 'approval'],
    description: [
      'Enter one registered workspace. Full-access environments return the workspace_context directly; restricted environments return a frozen approval request.',
      'Use this only when the user explicitly intends to work in that registered project. Do not select a workspace merely to read or search a path; if no project has been selected, use create_projectless_context for temporary execution context instead.',
      'Discover through tool_search and invoke through exec. If approval_required=true, call the top-level request_approval tool with the returned approval_id; do not retry select_workspace.',
      'Full-access skips user approval but keeps workspace identity validation, Worker routing, and workspace-context boundaries.',
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().describe('Environment whose Worker owns the workspace.'),
      workspace_id: z.string().min(1).describe('Registered workspace id on that Worker.'),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        const workspace = await runtime.workerHub.call(
          environment.id,
          'get_workspace',
          { workspace_id: args.workspace_id },
          { timeoutMs: 10_000 },
        );
        if (workspace.kind !== 'registered') {
          throw new Error('select_workspace only accepts registered workspaces.');
        }
        const intent = {
          environment_id: environment.id,
          workspace_id: workspace.workspace_id,
          workspace_root: workspace.root,
        };
        if (environment.permissionProfile === 'full-access') {
          return jsonResult(await executeWorkspaceAction(runtime, {
            operation: 'select_workspace',
            ...intent,
          }, { requireFullAccess: true }));
        }
        const justification =
          'Allow CCM to enter registered workspace ' +
          environment.id + ' / ' + workspace.workspace_id +
          ' at ' + workspace.root + '?';
        const approval = runtime.approvalManager.requestWorkspaceAction(
          'select_workspace',
          intent,
          justification,
        );
        return jsonResult({
          approval_required: true,
          ...approval,
          instruction:
            'Call the top-level request_approval tool with this approval_id. ' +
            'Do not retry select_workspace.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'register_workspace',
    provider: 'ccm-core',
    surfaces: { deferred: true, codeMode: true },
    tags: ['workspace', 'project', 'approval', 'register'],
    description: [
      'Register and enter one exact project directory. Full-access environments return the workspace_context directly; restricted environments return a frozen approval request.',
      'Use this only when the user explicitly intends to register that concrete directory as a project. Do not register a directory merely to gain read access; if only temporary execution context is needed, use create_projectless_context instead.',
      'Discover through tool_search and invoke through exec. If approval_required=true, call the top-level request_approval tool with the returned approval_id; do not retry register_workspace.',
      'With create_if_missing=true, registration may create the exact missing directory before entry. Full-access skips user approval but keeps target revalidation and workspace-context boundaries.',
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().describe('Environment whose Worker owns the directory.'),
      path: z.string().min(1).describe('Absolute project directory path on the selected Worker.'),
      workspace_id: z.string().min(1).optional().describe('Optional Worker-local workspace id. Defaults to a safe form of the directory name.'),
      create_if_missing: z.boolean().optional().describe('Create the target directory during registration if it is missing. Defaults to false.'),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        const inspected = await runtime.workerHub.call(
          environment.id,
          'inspect_workspace_path',
          {
            path: args.path,
            workspace_id: args.workspace_id,
            create_if_missing: Boolean(args.create_if_missing),
          },
          { timeoutMs: 10_000 },
        );
        const intent = {
          environment_id: environment.id,
          workspace_id: inspected.workspace_id,
          workspace_root: inspected.root,
          create_if_missing: Boolean(args.create_if_missing),
        };
        if (environment.permissionProfile === 'full-access') {
          return jsonResult(await executeWorkspaceAction(runtime, {
            operation: 'register_workspace',
            ...intent,
          }, { requireFullAccess: true }));
        }
        const action = inspected.create_required
          ? 'create, register, and enter workspace '
          : 'register and enter workspace ';
        const justification =
          'Allow CCM to ' + action +
          environment.id + ' / ' + inspected.workspace_id +
          ' at ' + inspected.root + '?';
        const approval = runtime.approvalManager.requestWorkspaceAction(
          'register_workspace',
          intent,
          justification,
        );
        return jsonResult({
          approval_required: true,
          ...approval,
          instruction:
            'Call the top-level request_approval tool with this approval_id. ' +
            'Do not retry register_workspace.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'exec_command',
    provider: 'ccm-core',
    surfaces: { direct: true, codeMode: true },
    tags: ['shell', 'process', 'terminal', 'command'],
    environmentRequirements: { capabilities: ['exec'] },
    supportsParallel: true,
    description: [
      'Runs a command using plain pipes by default; set tty=true to allocate a PTY. Returns output or a session ID for ongoing interaction.',
      'workspace_context is required and determines the Worker, cwd/session ownership, and restricted-write root. It does not narrow filesystem reads below the environment\'s sandbox_read_scope. Do not pass or infer a separate environment for this command.',
      'If no project has been selected, first discover ccm.create_projectless_context with tool_search and invoke it through exec; then pass the returned workspace_context here. When sandbox_read_scope=host, that projectless context is sufficient for absolute-path reads anywhere readable on the selected Worker; do not select/register the target path merely to inspect it.',
      'In workspace-write environments, normal remote Git commands such as git clone/fetch/pull/push/ls-remote are handled automatically and do not require sandbox_permissions=require_escalated. Run remote Git as Git-only shell commands so CCM can recognize the trusted path.',
      'Controller-trusted package scripts such as a specifically trusted workspace npm test are also handled automatically through exec_command. Trust is bound to the workspace and current package.json script hash; if the script changes it stops matching and must not be treated as trusted.',
      'On Windows workspace-write, direct node --test invocations are also a built-in trusted full-access class because the restricted token cannot spawn the Node test workers. Test code therefore runs with host permissions.',
      'For a command that genuinely requires full-access outside a workspace-write sandbox, set sandbox_permissions=require_escalated and include an optional user-facing justification. You may also provide prefix_rule as ordered command tokens to propose the reusable scope shown by Always allow in workspace. CCM freezes the exact command and the validated persistent scope before returning approval_required=true; then call request_approval with the returned approval_id.',
      'Persistent execution rules are ordered-token prefixes. A saved prefix can authorize additional suffix arguments on later matching escalations. For WSL, prefix_rule=["wsl.exe"] intentionally authorizes arbitrary later WSL suffix operations in the same workspace/shell context.',
      'A CCM-originated result is identifiable by its structured CCM fields. If a host reports a Script error or safety/policy/tool-call failure without this tool returning a structured result, do not attribute that failure to CCM or claim CCM blocked the command.',
      'On Windows, keep destructive filesystem operations in one shell and verify resolved targets before recursive deletes or moves.',
    ].join('\n\n'),
    inputSchema: {
      cmd: z.string().min(1).describe('Shell command to execute.'),
      workspace_context: z.string().uuid().describe('Existing execution context. It selects the Worker and context root; obtain one with create_projectless_context, select_workspace, or register_workspace before executing. It is not itself the filesystem read boundary.'),
      workdir: z.string().optional().describe('Relative subdirectory inside the selected context root. Defaults to the context root.'),
      tty: z.boolean().optional().describe('True allocates a PTY; false or omitted uses plain pipes.'),
      yield_time_ms: z.number().int().max(30_000).nonnegative().optional().describe('Wait before the initial command call yields output or a session. Defaults to 2000 ms. Values above 5000 ms are clamped to 5000 ms; long-running commands continue in a session and should be resumed with write_stdin.'),
      max_output_tokens: z.number().int().positive().optional().describe('Output token budget. Defaults to 10000 tokens.'),
      shell: z.string().optional().describe("Shell binary to launch. Defaults to the environment's default shell."),
      sandbox_permissions: z.enum(['use_default', 'require_escalated']).optional().describe('Set require_escalated when this command genuinely needs full-access outside the normal sandbox.'),
      prefix_rule: z.array(z.string().min(1).max(4096)).min(1).max(64).optional().describe('Optional reusable ordered-token prefix proposed for Always allow in workspace. Valid only with require_escalated and must match exactly one executable segment of this command.'),
      justification: z.string().optional().describe('User-facing explanation for a require_escalated approval request.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args) => {
      try {
        if (!args.workspace_context) {
          throw new Error(
            'exec_command requires workspace_context for Worker routing/cwd. Use ccm.create_projectless_context through tool_search + exec when no project is selected; the target read path does not need to be selected as a workspace when sandbox_read_scope=host.',
          );
        }
        return execResult(await runtime.processManager.execCommand(args));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'request_approval',
    provider: 'ccm-core',
    surfaces: { direct: true },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    mcpMeta: {
      ui: {
        resourceUri: APPROVAL_UI_URI,
        visibility: ['model', 'app'],
      },
      'ui/resourceUri': APPROVAL_UI_URI,
      'openai/outputTemplate': APPROVAL_UI_URI,
      'openai/widgetAccessible': true,
    },
    tags: ['approval', 'permission', 'ui'],
    description: [
      'Render the CCM approval card for one already-frozen pending action.',
      'Pass only the approval_id returned by a CCM business tool with approval_required=true. This tool does not accept or modify the command, workspace, path, or other frozen action fields.',
      'After the card is shown, the approval app handles the user decision through resolve_pending_action. Do not recreate or retry the original action.',
    ].join('\n\n'),
    inputSchema: {
      approval_id: z.string().uuid().describe('Opaque pending approval id returned by a CCM tool.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args, context) => {
      try {
        const hostSession = context?.extra?._meta?.['openai/session'] || null;
        const prepared = runtime.approvalManager.prepareAppApproval(
          args.approval_id,
          { hostSession },
        );
        return approvalCardResult({
          value: {
            wall_time_seconds: 0,
            output: 'Waiting for the user to approve or deny this frozen action.',
            approval_required: true,
            ...prepared.request,
          },
          approvalNonce: prepared.approvalNonce,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'resolve_pending_action',
    provider: 'ccm-core',
    surfaces: { direct: true },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    mcpMeta: {
      ui: { visibility: ['app'] },
      'openai/widgetAccessible': true,
    },
    tags: ['approval', 'sandbox', 'permission', 'app-only'],
    environmentRequirements: { capabilities: ['exec'] },
    description: [
      'App-only resolver for a frozen CCM approval request. It is invoked by the CCM approval card, not by the model.',
      'On approve, CCM resumes only the previously frozen execution or workspace action. approve_workspace stores a constrained policy only for execution approvals. This tool accepts no command, workspace target, workdir, or shell override.',
    ].join('\n\n'),
    inputSchema: {
      approval_id: z.string().uuid().describe('Frozen CCM approval identifier.'),
      approval_nonce: z.string().min(20).describe('One-time card secret delivered only through tool-result _meta.'),
      decision: z.enum(['approve', 'approve_workspace', 'deny']).describe('User decision from the CCM approval card.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args, context) => {
      try {
        const hostSession = context?.extra?._meta?.['openai/session'] || null;
        const pending = runtime.approvalManager.getRequest(args.approval_id);
        if (pending.kind === 'workspace') {
          return execResult(await resolvePendingWorkspaceAction(
            runtime,
            args,
            { hostSession },
          ));
        }
        return execResult(
          await runtime.processManager.resolvePendingExecution(
            args,
            { hostSession },
          ),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'write_stdin',
    provider: 'ccm-core',
    surfaces: { direct: true, codeMode: true },
    tags: ['process', 'terminal', 'session', 'stdin'],
    description: [
      'Writes characters to an existing unified exec session and returns recent output.',
      'workspace_context is required and must match the context that created session_id. Copy both values from the exec_command result; CCM rejects cross-workspace session continuation before contacting the Worker.',
    ].join(' '),
    inputSchema: {
      session_id: z.number().int().describe('Identifier of the running unified exec session.'),
      workspace_context: z.string().uuid().describe('Workspace context returned with the exec_command session_id. It must own that session.'),
      chars: z.string().optional().describe('Bytes to write to stdin. Defaults to empty, which polls without writing.'),
      yield_time_ms: z.number().int().max(30_000).nonnegative().optional().describe('Non-empty writes default to 250 ms; empty polls default to 1000 ms. All write_stdin waits cap at 30000 ms.'),
      max_output_tokens: z.number().int().positive().optional().describe('Output token budget. Defaults to 10000 tokens.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args) => {
      try {
        return execResult(await runtime.processManager.writeStdin(args));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'apply_patch',
    provider: 'ccm-core',
    surfaces: { direct: true, codeMode: true },
    tags: ['edit', 'patch', 'filesystem'],
    environmentRequirements: { capabilities: ['applyPatch'] },
    description: [
      'Apply a Codex-style Begin/End Patch inside an existing workspace_context.',
      'If the user has not selected a project, automatically obtain a projectless context first through ccm.create_projectless_context; do not ask the user to choose or register a temporary directory.',
    ].join('\n\n'),
    inputSchema: {
      patch: z.string().min(1).describe('Codex-style patch text beginning with *** Begin Patch.'),
      workspace_context: z.string().uuid().describe('Existing workspace context.'),
      workdir: z.string().optional().describe('Relative subdirectory inside the selected context root.'),
    },
    handler: async (args) => {
      try {
        return patchResult(await runtime.fileService.applyPatch({
          ...args,
          workspace_scoped: true,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'view_image',
    provider: 'ccm-core',
    surfaces: { direct: true, codeMode: true },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    tags: ['image', 'filesystem', 'media'],
    environmentRequirements: { capabilities: ['viewImage'] },
    supportsParallel: true,
    description: [
      'Read a bounded image from the selected CCM context root and return it as MCP image content.',
      'If the user has not selected a project, automatically obtain a projectless context first through ccm.create_projectless_context; do not ask the user to choose or register a temporary directory.',
      'This direct tool is also available through exec for nested or batched image calls.',
    ].join(' '),
    inputSchema: {
      path: z.string().min(1).describe('Image path relative to the selected context root.'),
      workspace_context: z.string().uuid().describe('Existing workspace context.'),
    },
    handler: async (args) => {
      try {
        return imageResult(await runtime.fileService.viewImage(args));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  return registry;
}
