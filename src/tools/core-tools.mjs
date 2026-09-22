import * as z from 'zod/v4';

const UNIFIED_EXEC_OUTPUT_SCHEMA = {
  chunk_id: z.string().optional(),
  wall_time_seconds: z.number(),
  exit_code: z.number().int().optional(),
  session_id: z.number().int().optional(),
  original_token_count: z.number().int().optional(),
  output: z.string(),
  approval_required: z.boolean().optional(),
  approval_id: z.string().optional(),
  state: z.enum(['pending', 'approved', 'denied', 'consumed']).optional(),
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
    structuredContent: {
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
    description: 'List CCM execution environments and their native shell, permissions, and capabilities.',
    inputSchema: {},
    handler: async () => jsonResult({
      default_environment_id: runtime.environmentRegistry.defaultEnvironmentId,
      environments: runtime.environmentRegistry.listPublic(),
    }),
  });

  registry.register({
    name: 'list_workspaces',
    provider: 'ccm-core',
    surfaces: { direct: true, codeMode: true },
    tags: ['workspace', 'project', 'environment'],
    supportsParallel: true,
    description: 'List registered workspaces on one CCM environment. This is discovery only and does not enter a workspace.',
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
    name: 'select_workspace',
    provider: 'ccm-core',
    surfaces: { direct: true },
    tags: ['workspace', 'project', 'approval'],
    description: [
      'Enter a registered workspace and return a workspace_context for subsequent CCM development calls.',
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
    surfaces: { direct: true },
    tags: ['workspace', 'project', 'approval', 'register'],
    description: [
      'Hot-register a new project directory on a Worker and immediately return a workspace_context for it.',
      'Registration expands CCM project access and always requires explicit user approval. Call once without approval_id, stop for user approval, call respond_to_escalation, then retry with the exact same target and approval_id.',
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().describe('Environment whose Worker owns the directory.'),
      path: z.string().min(1).describe('Absolute project directory path on the selected Worker.'),
      workspace_id: z.string().min(1).optional().describe('Optional Worker-local workspace id. Defaults to a safe form of the directory name.'),
      approval_id: z.string().uuid().optional().describe('One-shot approval id returned by the pending registration request.'),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        const inspected = await runtime.workerHub.call(
          environment.id,
          'inspect_workspace_path',
          { path: args.path, workspace_id: args.workspace_id },
          { timeoutMs: 10_000 },
        );
        const intent = {
          environment_id: environment.id,
          workspace_id: inspected.workspace_id,
          workspace_root: inspected.root,
        };
        if (!args.approval_id) {
          const approval = runtime.approvalManager.requestWorkspaceAction(
            'register_workspace',
            intent,
            'Allow CCM to register and enter workspace ' +
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
      'Pass workspace_context to continue work in an existing CCM workspace. If omitted, CCM creates a new isolated projectless workspace on the primary environment and returns its context.',
      'A CCM-originated result is identifiable by its structured CCM fields. If a host reports a Script error or safety/policy/tool-call failure without this tool returning a structured result, do not attribute that failure to CCM or claim CCM blocked the command.',
      'On Windows, keep destructive filesystem operations in one shell and verify resolved targets before recursive deletes or moves.',
    ].join('\n\n'),
    inputSchema: {
      cmd: z.string().min(1).describe('Shell command to execute.'),
      workspace_context: z.string().uuid().optional().describe('Existing workspace context. Omit only to intentionally start a new projectless workspace.'),
      workdir: z.string().optional().describe('Relative subdirectory inside the selected workspace. Defaults to the workspace root.'),
      tty: z.boolean().optional().describe('True allocates a PTY; false or omitted uses plain pipes.'),
      yield_time_ms: z.number().int().max(30_000).nonnegative().optional().describe('Wait before the initial command call yields output or a session. Defaults to 2000 ms. Values above 5000 ms are accepted for compatibility but are clamped to 5000 ms; long-running commands continue in a session and should be resumed with write_stdin.'),
      max_output_tokens: z.number().int().positive().optional().describe('Output token budget. Defaults to 10000 tokens.'),
      shell: z.string().optional().describe("Shell binary to launch. Defaults to the environment's default shell."),
      sandbox_permissions: z.enum(['use_default', 'require_escalated']).optional().describe('Per-command sandbox override. Defaults to use_default.'),
      justification: z.string().optional().describe('User-facing approval question for require_escalated; omit otherwise.'),
      approval_id: z.string().uuid().optional().describe('One-shot approval id returned by an earlier require_escalated request. Retry the exact same execution with this id only after the user explicitly approves it.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args) => {
      try {
        return execResult(await runtime.processManager.execCommand(args));
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
      'Records the user response to a pending one-shot CCM approval request, including workspace access and execution escalation.',
      'MUST NOT approve unless the user explicitly approved the displayed request in a user message.',
      'Approval does not perform the pending action; retry the exact requesting tool with the same approval_id.',
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
    description: 'Writes characters to an existing unified exec session and returns recent output.',
    inputSchema: {
      session_id: z.number().int().describe('Identifier of the running unified exec session.'),
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
    description: 'Apply a Codex-style Begin/End Patch inside the selected CCM workspace.',
    inputSchema: {
      patch: z.string().min(1).describe('Codex-style patch text beginning with *** Begin Patch.'),
      workspace_context: z.string().uuid().optional().describe('Existing workspace context. Omit only to intentionally start a new projectless workspace.'),
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
    surfaces: { direct: true },
    tags: ['image', 'filesystem', 'media'],
    environmentRequirements: { capabilities: ['viewImage'] },
    supportsParallel: true,
    description: 'Read a bounded image from the selected CCM workspace and return it as MCP image content.',
    inputSchema: {
      path: z.string().min(1).describe('Image path relative to the selected workspace root.'),
      workspace_context: z.string().uuid().optional().describe('Existing workspace context. Omit only to intentionally start a new projectless workspace.'),
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
