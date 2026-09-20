import * as z from 'zod/v4';
import { ToolExposure } from './tool-registry.mjs';

const UNIFIED_EXEC_OUTPUT_SCHEMA = {
  chunk_id: z.string().optional(),
  wall_time_seconds: z.number(),
  exit_code: z.number().int().optional(),
  session_id: z.number().int().optional(),
  original_token_count: z.number().int().optional(),
  output: z.string(),
};

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function execResult(value) {
  const lines = [];
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
    exposure: ToolExposure.DIRECT,
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
    exposure: ToolExposure.DIRECT,
    description: [
      'Runs a command in a PTY, returning output or a session ID for ongoing interaction.',
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
      prefix_rule: z.array(z.string()).optional().describe('Reusable approval prefix for cmd; only meaningful with require_escalated.'),
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
    name: 'write_stdin',
    provider: 'ccm-core',
    exposure: ToolExposure.DIRECT,
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

  return registry;
}
