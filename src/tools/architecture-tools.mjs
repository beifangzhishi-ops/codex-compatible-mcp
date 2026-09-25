import * as z from 'zod/v4';
import { CodeModeManager } from './code-mode-manager.mjs';

function jsonResult(value, text = null, extraContent = []) {
  return {
    content: [
      {
        type: 'text',
        text: text ?? JSON.stringify(value, null, 2),
      },
      ...extraContent,
    ],
    structuredContent: value,
  };
}

function toolError(error) {
  return {
    content: [{ type: 'text', text: String(error?.message || error) }],
    isError: true,
  };
}

const nestedCallSchema = z.object({
  tool: z.string().min(1).describe(
    'Qualified nested tool name returned by tool_search, or an unambiguous tool name.',
  ),
  arguments: z.record(z.string(), z.unknown()).optional().describe(
    'Arguments for the nested tool.',
  ),
});

const nativeFileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}).strict();

export function registerArchitectureTools(
  registry,
  { codeModeManager = new CodeModeManager({ registry }) } = {},
) {
  registry.register({
    name: 'tool_search',
    provider: 'ccm-runtime',
    provenance: 'ccm-runtime',
    surfaces: { direct: true },
    tags: ['tools', 'discovery', 'registry'],
    supportsParallel: true,
    description: [
      'Search deferred CCM capabilities without adding their schemas to the top-level MCP tool list.',
      'Results include qualified names, descriptions, input schemas, exposure surfaces, provenance, and environment requirements.',
      'Invoke discovered capabilities through exec.',
    ].join('\n\n'),
    inputSchema: {
      query: z.string().default('').describe(
        'Search terms separated by spaces or punctuation. Empty returns the first deferred capabilities. Multi-term searches rank full matches first and may return partial matches.',
      ),
      limit: z.number().int().min(1).max(25).optional().describe(
        'Maximum number of matches. Defaults to 8.',
      ),
    },
    handler: async (args) => {
      try {
        const matches = registry.searchDeferred(args.query, {
          limit: args.limit,
        });
        return jsonResult({
          query: args.query,
          count: matches.length,
          tools: matches,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'exec',
    provider: 'ccm-runtime',
    provenance: 'ccm-runtime',
    surfaces: { direct: true },
    tags: ['tools', 'code-mode', 'orchestration', 'batch'],
    mcpMeta: {
      'openai/fileParams': ['file'],
    },
    description: [
      'Execute one or more ToolRegistry capabilities through CCM nested dispatch.',
      'Prefer one exec call for multi-step CCM work when the required tools are available on the Code Mode surface. Core tools such as list_projects, exec_command, write_stdin, and apply_patch can be nested here alongside deferred ccm-extra tools. This avoids repeated host MCP connection/initialization round trips.',
      'For a real ChatGPT attachment consumed by one nested capability such as ccm-extra.receive_file, pass that attachment through the optional top-level file parameter. ChatGPT resolves it to the native file object and CCM injects it into that single nested call as arguments.file. Do not also provide arguments.file in the nested call.',
      'This is a structured dispatcher, not a JavaScript interpreter. Use the host Code Mode for loops, branching, and data processing.',
      'Set parallel=true only for independent calls; CCM rejects parallel execution for tools that do not declare parallel-call support.',
      'For bulk local image review, search for ccm.view_image once and batch independent image calls in this exec dispatcher with parallel=true; image content is passed through natively without widget cards.',
      'If this returns state=running, resume the outer cell with wait. If it returns state=awaiting_io, the nested runner is finished but one or more process sessions are still live and must be continued with write_stdin. state=completed is terminal and never carries live sessions.',
    ].join('\n\n'),
    inputSchema: {
      calls: z.array(nestedCallSchema).min(1).max(32).describe(
        'Nested capability calls to execute. These may include Code Mode-enabled core tools (for example list_projects, exec_command, write_stdin, apply_patch) and discovered deferred capabilities.',
      ),
      file: nativeFileSchema.optional().describe(
        'Optional single ChatGPT file binding for exactly one nested call. ChatGPT supplies download_url and file_id plus optional mime_type/file_name; CCM injects this object as that call\'s arguments.file before normal nested-tool validation.',
      ),
      parallel: z.boolean().optional().describe(
        'Run independent calls concurrently. Defaults to false.',
      ),
      continue_on_error: z.boolean().optional().describe(
        'For sequential execution, continue after a nested tool error. Defaults to false.',
      ),
      yield_time_ms: z.number().int().min(0).max(30_000).optional().describe(
        'Wait for completion before yielding a cell_id. Defaults to 10000 ms.',
      ),
      max_output_tokens: z.number().int().min(256).max(20_000).optional().describe(
        'Approximate aggregate output budget. Defaults to 10000 tokens.',
      ),
    },
    handler: async (args) => {
      try {
        let dispatchArgs = args;
        if (args.file !== undefined) {
          if (args.calls.length !== 1) {
            throw new Error(
              'exec.file requires exactly one nested tool call.',
            );
          }
          const [call] = args.calls;
          if (Object.prototype.hasOwnProperty.call(call.arguments || {}, 'file')) {
            throw new Error(
              'exec.file cannot be combined with calls[0].arguments.file.',
            );
          }
          const { file, ...rest } = args;
          dispatchArgs = {
            ...rest,
            calls: [{
              ...call,
              arguments: {
                ...(call.arguments || {}),
                file,
              },
            }],
          };
        }
        const result = await codeModeManager.exec(dispatchArgs);
        return jsonResult(result.payload, result.text, result.content);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'wait',
    provider: 'ccm-runtime',
    provenance: 'ccm-runtime',
    surfaces: { direct: true },
    tags: ['tools', 'code-mode', 'orchestration', 'wait'],
    description: [
      'Resume a running CCM nested exec cell.',
      'Use this only when exec returned state=running and a cell_id.',
      'Completion returns only nested call results not already delivered by the earlier exec/wait response.',
    ].join('\n\n'),
    inputSchema: {
      cell_id: z.string().min(1).describe('Running cell identifier returned by exec.'),
      yield_time_ms: z.number().int().min(0).max(30_000).optional().describe(
        'Wait before yielding again. Defaults to 5000 ms.',
      ),
      max_output_tokens: z.number().int().min(256).max(20_000).optional().describe(
        'Approximate output budget for newly delivered nested results.',
      ),
    },
    handler: async (args) => {
      try {
        const result = await codeModeManager.wait(args);
        return jsonResult(result.payload, result.text, result.content);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  return { registry, codeModeManager };
}
