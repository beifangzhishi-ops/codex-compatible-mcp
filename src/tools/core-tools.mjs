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
  created_at: z.string().optional(),
  policy_auto_approved: z.boolean().optional(),
  policy_saved: z.boolean().optional(),
  policy_rule_id: z.string().optional(),
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
    lines.push('Expires: ' + value.expires_at);
    lines.push('Justification: ' + value.justification);
    lines.push(
      'Stop and ask the user for explicit approval. ' +
      'After approval, call respond_to_escalation and retry exec_command ' +
      'with the same command plus this approval_id.',
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
    return {
      content: [{
        type: 'text',
        text: [
          'CCM executed this full-access command under an existing workspace policy.',
          'Environment: ' + value.environment_id,
          'Workspace: ' + value.workspace_id,
          'Command: ' + value.command,
          'Policy rule: ' + value.policy_rule_id,
          'No additional user approval was required.',
        ].join('\n'),
      }],
      structuredContent: value,
      _meta: { source: 'ccm.exec-policy' },
    };
  }
  const lines = [
    'CCM prepared a frozen full-access command for user approval.',
    'Approval ID: ' + value.approval_id,
    'Operation ID: ' + value.operation_id,
    'Environment: ' + value.environment_id,
    'Workspace: ' + value.workspace_id,
    'Command: ' + value.command,
    'Expires: ' + value.expires_at,
    'The attached CCM approval card is the only valid approval path for this request.',
    'Do not call respond_to_escalation and do not recreate or retry this command yourself.',
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
    name: 'list_environments',
    provider: 'ccm-core',
    surfaces: { direct: true, codeMode: true },
    tags: ['environment', 'worker', 'capabilities'],
    supportsParallel: true,
    description: 'List CCM execution environments, platform/shell metadata, capabilities, effective high-level filesystem read/write scope, backend, and default selection. Internal bootstrap directories, raw permission profiles, and filesystem permission topology are intentionally not exposed.',
    inputSchema: {},
    handler: async () => jsonResult({
      default_environment_id: runtime.environmentRegistry.defaultEnvironmentId,
      environments: runtime.environmentRegistry.listPublic(),
    }),
  });

  registry.register({
    name: 'list_workspaces',
    provider: 'ccm-core',
    surfaces: { deferred: true, codeMode: true },
    tags: ['workspace', 'project', 'environment'],
    supportsParallel: true,
    description: 'List registered workspaces on one CCM environment. This is discovery only and does not enter a workspace. Discover through tool_search and invoke through exec.',
    inputSchema: {
      environment_id: z.string().optional().describe('Environment whose Worker owns the workspaces. Omit to use the primary environment.'),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        const result = await runtime.workerHub.call(
          environment.id,
          'list_workspaces',
          {},
          { timeoutMs: 10_000 },
        );
        return jsonResult({
          environment_id: environment.id,
          workspaces: result.workspaces || [],
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
      'Create a projectless workspace_context for temporary execution without entering or registering a real project.',
      'Use this whenever a target environment is known but the user did not explicitly select a project. If environment_id is omitted, CCM uses the primary environment.',
      'Projectless context creation does not require workspace approval. Do not register Temp, Documents, a drive root, or another arbitrary directory merely to obtain an execution context.',
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
      'Enter a registered workspace and return a workspace_context for subsequent CCM development calls.',
      'Workspace approval establishes the selected project execution context.',
      'Use this only when the user explicitly intends to work in a registered project. For temporary execution without a selected project, use create_projectless_context instead.',
      'Entering a registered workspace always requires explicit user approval. Call once without approval_id, stop for user approval, call respond_to_escalation, then retry with the same target and approval_id.',
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().describe('Environment whose Worker owns the workspace.'),
      workspace_id: z.string().min(1).describe('Registered workspace id on that Worker.'),
      approval_id: z.string().uuid().optional().describe('One-shot approval id returned by the pending selection request.'),
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
        if (!args.approval_id) {
          const approval = runtime.approvalManager.requestWorkspaceAction(
            'select_workspace',
            intent,
            'Allow CCM to enter registered workspace ' +
              environment.id + ' / ' + workspace.workspace_id +
              ' at ' + workspace.root + '?',
          );
          return jsonResult({
            approval_required: true,
            ...approval,
            instruction:
              'Stop and ask the user for explicit approval. After approval, ' +
              'call respond_to_escalation and retry select_workspace with ' +
              'the same target plus this approval_id.',
          });
        }
        runtime.approvalManager.consumeWorkspaceAction(
          args.approval_id,
          'select_workspace',
          intent,
        );
        return jsonResult(
          runtime.workspaceContextManager.createRegistered(
            environment.id,
            workspace,
          ),
        );
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
      'Register a project directory on a Worker and immediately return a workspace_context for it. With create_if_missing=true, one approved flow may create the missing directory, register it, and enter it.',
      'Use this only when the user explicitly intends to register that concrete directory as a project. Do not register a temporary directory merely to obtain an execution context; use create_projectless_context instead.',
      'Registration expands CCM project access and always requires explicit user approval. If create_if_missing=true, the approval is also narrowly scoped to creating that exact directory if it is still missing. Call once without approval_id, stop for user approval, call respond_to_escalation, then retry with the exact same target, create_if_missing value, and approval_id.',
      'This workspace approval authorizes only the create/register/enter action. It is not authorization to begin implementation when the user is still planning.',
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().describe('Environment whose Worker owns the directory.'),
      path: z.string().min(1).describe('Absolute project directory path on the selected Worker.'),
      workspace_id: z.string().min(1).optional().describe('Optional Worker-local workspace id. Defaults to a safe form of the directory name.'),
      create_if_missing: z.boolean().optional().describe('Create the target directory after approval if it is missing. Defaults to false.'),
      approval_id: z.string().uuid().optional().describe('One-shot approval id returned by the pending registration request.'),
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
        if (!args.approval_id) {
          const action = inspected.create_required
            ? 'create, register, and enter workspace '
            : 'register and enter workspace ';
          const approval = runtime.approvalManager.requestWorkspaceAction(
            'register_workspace',
            intent,
            'Allow CCM to ' + action +
              environment.id + ' / ' + inspected.workspace_id +
              ' at ' + inspected.root + '?',
          );
          return jsonResult({
            approval_required: true,
            ...approval,
            instruction:
              'Stop and ask the user for explicit approval. After approval, ' +
              'call respond_to_escalation and retry register_workspace with ' +
              'the same target plus this approval_id.',
          });
        }
        runtime.approvalManager.consumeWorkspaceAction(
          args.approval_id,
          'register_workspace',
          intent,
        );
        const workspace = await runtime.workerHub.call(
          environment.id,
          'register_workspace',
          {
            path: inspected.root,
            workspace_id: inspected.workspace_id,
            create_if_missing: Boolean(args.create_if_missing),
            approved_root: inspected.root,
          },
          { timeoutMs: 10_000 },
        );
        return jsonResult(
          runtime.workspaceContextManager.createRegistered(
            environment.id,
            workspace,
          ),
        );
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
      'workspace_context is required and already determines the environment and workspace. Do not pass or infer a separate environment for this command.',
      'If no project has been selected, first discover ccm.create_projectless_context with tool_search and invoke it through exec; then pass the returned workspace_context here.',
      'In workspace-write environments, normal remote Git commands such as git clone/fetch/pull/push/ls-remote are handled automatically and do not require sandbox_permissions=require_escalated. Run remote Git as Git-only shell commands so CCM can recognize the trusted path.',
      'For a non-Git command that genuinely requires full-access outside a workspace-write sandbox, use the direct request_escalated_exec tool. Do not start a new approval with sandbox_permissions=require_escalated; that legacy parameter is retained only for migration of an already-issued approval_id.',
      'A CCM-originated result is identifiable by its structured CCM fields. If a host reports a Script error or safety/policy/tool-call failure without this tool returning a structured result, do not attribute that failure to CCM or claim CCM blocked the command.',
      'On Windows, keep destructive filesystem operations in one shell and verify resolved targets before recursive deletes or moves.',
    ].join('\n\n'),
    inputSchema: {
      cmd: z.string().min(1).describe('Shell command to execute.'),
      workspace_context: z.string().uuid().describe('Existing workspace context. Obtain one with create_projectless_context, select_workspace, or register_workspace before executing.'),
      workdir: z.string().optional().describe('Relative subdirectory inside the selected workspace. Defaults to the workspace root.'),
      tty: z.boolean().optional().describe('True allocates a PTY; false or omitted uses plain pipes.'),
      yield_time_ms: z.number().int().max(30_000).nonnegative().optional().describe('Wait before the initial command call yields output or a session. Defaults to 2000 ms. Values above 5000 ms are accepted for compatibility but are clamped to 5000 ms; long-running commands continue in a session and should be resumed with write_stdin.'),
      max_output_tokens: z.number().int().positive().optional().describe('Output token budget. Defaults to 10000 tokens.'),
      shell: z.string().optional().describe("Shell binary to launch. Defaults to the environment's default shell."),
      sandbox_permissions: z.enum(['use_default', 'require_escalated']).optional().describe('Legacy compatibility override. New escalations must use request_escalated_exec; ordinary calls should omit this or use use_default.'),
      justification: z.string().optional().describe('Legacy execution-approval compatibility field. New escalations put the justification on request_escalated_exec.'),
      approval_id: z.string().uuid().optional().describe('Legacy one-shot execution approval id. New CCM approval-card requests never expose an approval_id for model-driven retry.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args) => {
      try {
        if (!args.workspace_context) {
          throw new Error(
            'exec_command requires workspace_context. Use ccm.create_projectless_context through tool_search + exec when no project is selected.',
          );
        }
        if (args.sandbox_permissions === 'require_escalated' &&
            !args.approval_id) {
          throw new Error(
            'Direct escalation moved to request_escalated_exec. ' +
            'Call request_escalated_exec with the same frozen command and workspace_context so ChatGPT can render the CCM approval card.',
          );
        }
        return execResult(await runtime.processManager.execCommand(args));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'request_escalated_exec',
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
    tags: ['approval', 'sandbox', 'permission', 'shell', 'process'],
    environmentRequirements: { capabilities: ['exec'] },
    description: [
      'Prepare one full-access command for explicit user approval in the CCM approval card. This tool freezes the exact action but does not execute it.',
      'Use this direct tool instead of exec_command(sandbox_permissions=require_escalated) when a workspace-write environment genuinely requires execution outside the sandbox.',
      'The user decision is handled inside the CCM approval card. After this tool returns, do not call respond_to_escalation, do not reconstruct the command, and do not issue a second execution request for the same action.',
      'Trusted remote Git uses exec_command directly and should not use this tool.',
    ].join('\n\n'),
    inputSchema: {
      cmd: z.string().min(1).describe('Exact shell command to freeze for one approved full-access execution.'),
      workspace_context: z.string().uuid().describe('Existing workspace context that owns this command.'),
      workdir: z.string().optional().describe('Relative subdirectory inside the selected workspace.'),
      tty: z.boolean().optional().describe('True allocates a PTY; false or omitted uses plain pipes.'),
      yield_time_ms: z.number().int().max(30_000).nonnegative().optional().describe('Initial wait before yielding output or a session. Values above 5000 ms are clamped to 5000 ms.'),
      max_output_tokens: z.number().int().positive().optional().describe('Output token budget. Defaults to 10000 tokens.'),
      shell: z.string().optional().describe("Shell binary to launch. Defaults to the environment's default shell."),
      justification: z.string().min(1).optional().describe('User-facing explanation of why this exact command requires full-access.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args, context) => {
      try {
        const hostSession = context?.extra?._meta?.['openai/session'] || null;
        return approvalCardResult(
          await runtime.processManager.prepareEscalatedCommand(
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
      'On approve, CCM resumes only the previously frozen action. approve_workspace also stores a constrained workspace policy for future matching executions. This tool accepts no command, workspace, workdir, or shell override.',
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
        return execResult(await runtime.processManager.resolvePendingExecution(
          args,
          { hostSession },
        ));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'respond_to_escalation',
    provider: 'ccm-core',
    surfaces: { direct: true },
    tags: ['approval', 'sandbox', 'permission'],
    description: [
      'Records the user response to a legacy CCM approval request, primarily workspace access for select_workspace/register_workspace.',
      'MUST NOT approve unless the user explicitly approved the displayed request in a user message.',
      'Do not use this tool for request_escalated_exec approvals; those are resolved only by the CCM approval card. Legacy workspace approval does not perform the pending action; retry the exact workspace tool with the same approval_id.',
    ].join('\n\n'),
    inputSchema: {
      approval_id: z.string().uuid().describe('Pending approval id returned by the requesting CCM tool.'),
      decision: z.enum(['approve', 'deny']).describe('The user\'s explicit decision.'),
    },
    handler: async (args) => {
      try {
        if (!runtime.approvalManager) {
          throw new Error('CCM approval manager is not available.');
        }
        return jsonResult(runtime.approvalManager.respond(
          args.approval_id,
          args.decision,
        ));
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
      workdir: z.string().optional().describe('Relative subdirectory inside the selected workspace.'),
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
      'Read a bounded image from the selected CCM workspace and return it as MCP image content.',
      'If the user has not selected a project, automatically obtain a projectless context first through ccm.create_projectless_context; do not ask the user to choose or register a temporary directory.',
      'This direct tool is also available through exec for nested or batched image calls.',
    ].join(' '),
    inputSchema: {
      path: z.string().min(1).describe('Image path relative to the selected workspace root.'),
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
