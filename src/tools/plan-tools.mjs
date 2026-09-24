import * as z from 'zod/v4';

function toolError(error) {
  return {
    content: [{ type: 'text', text: String(error?.message || error) }],
    isError: true,
  };
}

function patchResult(value) {
  const action = value.created ? 'Created' : 'Updated';
  return {
    content: [{
      type: 'text',
      text: action + ' durable CCM Plan ' + value.plan_id + '.',
    }],
    structuredContent: value,
  };
}

function readResult(value) {
  let text;
  if (value.mode === 'search') {
    const lines = [];
    for (const match of value.matches) {
      lines.push('Match at line ' + match.line + ':');
      for (const entry of match.context) {
        lines.push(String(entry.line).padStart(6) + ': ' + entry.text);
      }
      lines.push('');
    }
    if (value.truncated) {
      lines.push(
        'Search results truncated: showing ' + value.matches.length +
        ' of ' + value.total_matches + ' matches. Refine query for more specific results.',
      );
    }
    text = lines.join('\n').trimEnd();
  } else {
    text = value.content;
    if (value.truncated) {
      text += value.next_start_line != null
        ? '\n\n[Plan read truncated; continue at start_line=' + value.next_start_line + ']'
        : '\n\n[Plan read truncated within an oversized line.]';
    }
  }
  return {
    content: [{ type: 'text', text }],
    structuredContent: value,
  };
}

const planReadValidator = z.object({
  plan_id: z.string().uuid(),
  start_line: z.number().int().positive().optional(),
  end_line: z.number().int().positive().optional(),
  query: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.query != null && (value.start_line != null || value.end_line != null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'query is mutually exclusive with start_line/end_line',
    });
  }
  if (value.start_line != null && value.end_line != null &&
      value.start_line > value.end_line) {
    ctx.addIssue({
      code: 'custom',
      message: 'start_line must be less than or equal to end_line',
    });
  }
});

export function registerPlanTools(registry, runtime) {
  registry.register({
    name: 'plan_patch',
    provider: 'ccm-core',
    surfaces: { deferred: true, codeMode: true },
    tags: ['plan', 'planning', 'patch', 'codex'],
    description: [
      'Create or update one durable CCM Plan using the same Codex-style patch grammar as apply_patch. Omit plan_id to create a new Plan with exactly one `*** Add File: plan.md` hunk; pass plan_id to update that Plan with exactly one `*** Update File: plan.md` hunk. No real filesystem path is accepted.',
      'Planning guidance: when the user asks to plan, discuss, or re-plan before implementation, first ground the plan in discoverable facts with targeted non-mutating inspection; then resolve user intent, success criteria, scope, constraints, and material tradeoffs; then resolve implementation approach, interfaces/data flow, edge cases/failure modes, tests/acceptance criteria, and migration/cleanup decisions until another executor could implement without redesigning the solution. Do not preserve historical compatibility unless the user explicitly asks for it.',
      'Keep the durable Plan current rather than append-only. As facts, decisions, and execution state change, promptly rewrite or remove completed, invalidated, obsolete, superseded, or otherwise stale items while preserving unresolved decisions, active constraints, and useful acceptance criteria.',
      'Execution gate: unless the user has clearly and explicitly instructed execution/implementation, remain in planning. Imperative task wording, a request to update/review/re-plan, successful inspection, Plan patching itself, workspace approval (including select_workspace/register_workspace), sandbox escalation approval, or another prerequisite approval does not count as execution authorization. Without explicit execution instruction, do not make repo-tracked implementation changes.',
      'If the user has already explicitly switched to implementation, patching an existing Plan does not switch the workflow back to planning. CCM itself has no Plan-Mode state machine.',
    ].join('\n\n'),
    inputSchema: {
      plan_id: z.string().uuid().optional().describe(
        'Opaque Plan id returned by the first plan_patch call. Omit only to create a new logical Plan.',
      ),
      patch: z.string().min(1).describe(
        'Codex-style Begin/End Patch text targeting only the virtual file plan.md.',
      ),
    },
    handler: async (args) => {
      try {
        if (!runtime.planManager) throw new Error('CCM Plan manager is unavailable.');
        return patchResult(
          args.plan_id
            ? await runtime.planManager.patch(args.plan_id, args.patch)
            : await runtime.planManager.create(args.patch),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'plan_read',
    provider: 'ccm-core',
    surfaces: { deferred: true, codeMode: true },
    tags: ['plan', 'read', 'search', 'lines'],
    supportsParallel: true,
    description: 'Read only the Plan identified by plan_id. With no range/query, reads a bounded prefix; start_line/end_line reads a bounded 1-based line range; query performs literal case-insensitive substring search within that Plan and returns 1-based match/context line numbers. This is a lifecycle-neutral reference lookup: it does not enter, exit, resume, or re-enter planning behavior and should not interrupt an implementation workflow.',
    inputSchema: {
      plan_id: z.string().uuid().describe('Opaque Plan id to read.'),
      start_line: z.number().int().positive().optional().describe('Optional 1-based first line. Mutually exclusive with query.'),
      end_line: z.number().int().positive().optional().describe('Optional 1-based last line. Mutually exclusive with query.'),
      query: z.string().min(1).optional().describe('Optional literal substring search within this Plan only.'),
    },
    validateArguments: (args) => planReadValidator.parse(args ?? {}),
    handler: async (args) => {
      try {
        if (!runtime.planManager) throw new Error('CCM Plan manager is unavailable.');
        return readResult(await runtime.planManager.read(args.plan_id, {
          startLine: args.start_line,
          endLine: args.end_line,
          query: args.query,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  return registry;
}
