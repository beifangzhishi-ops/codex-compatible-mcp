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
    description: 'List CCM execution environments and their native shell, workspace, permissions, and capabilities.',
    inputSchema: {},
    handler: async () => jsonResult({
      default_environment_id: runtime.environmentRegistry.defaultEnvironmentId,
      environments: runtime.environmentRegistry.listPublic(),
    }),
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
      'On Windows, keep destructive filesystem operations in one shell and verify resolved targets before recursive deletes or moves.',
    ].join('\n\n'),
    inputSchema: {
      cmd: z.string().min(1).describe('Shell command to execute.'),
      workdir: z.string().optional().describe('Working directory for the command. Defaults to the environment cwd.'),
      tty: z.boolean().optional().describe('True allocates a PTY; false or omitted uses plain pipes.'),
      yield_time_ms: z.number().int().nonnegative().optional().describe('Wait before yielding output. Defaults to 10000 ms. Windows effective range is 10000-30000 ms.'),
      max_output_tokens: z.number().int().positive().optional().describe('Output token budget. Defaults to 10000 tokens.'),
      shell: z.string().optional().describe("Shell binary to launch. Defaults to the environment's default shell."),
      environment_id: z.string().optional().describe('Environment id. Omit to use the primary environment.'),
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
      'Records the user response to a pending one-shot CCM escalation request.',
      'MUST NOT approve unless the user explicitly approved the displayed request in a user message.',
      'Approval does not execute anything; retry the exact exec_command with sandbox_permissions=require_escalated and the same approval_id.',
    ].join('\n\n'),
    inputSchema: {
      approval_id: z.string().uuid().describe('Pending approval id returned by exec_command.'),
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
      yield_time_ms: z.number().int().nonnegative().optional().describe('Non-empty writes default to 250 ms and cap at 30000 ms; empty polls default to at least 5000 ms and may wait up to 300000 ms.'),
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
    description: 'Apply a Codex-style Begin/End Patch against the selected Remote Worker filesystem.',
    inputSchema: {
      patch: z.string().min(1).describe('Codex-style patch text beginning with *** Begin Patch.'),
      workdir: z.string().optional().describe('Working directory used to resolve relative patch paths.'),
      environment_id: z.string().optional().describe('Environment id. May also be supplied by the patch preamble.'),
    },
    handler: async (args) => {
      try {
        return patchResult(await runtime.fileService.applyPatch(args));
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
    description: 'Read a bounded image from the selected Remote Worker and return it as MCP image content.',
    inputSchema: {
      path: z.string().min(1).describe('Image path relative to the environment cwd, or an absolute native path.'),
      environment_id: z.string().optional().describe('Environment id. Omit to use the default environment.'),
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
