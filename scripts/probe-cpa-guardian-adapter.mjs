// Opt-in real CPA protocol test against the production reviewer client and
// ToolRegistry dispatcher. Both tools return only in-memory fixture data.
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { fileURLToPath } from 'node:url';
import { CpaReviewClient } from '../src/controller/cpa-review-client.mjs';
import { GuardianToolDispatcher } from '../src/controller/guardian-tool-dispatcher.mjs';
import { GUARDIAN_OUTPUT_SCHEMA, parseGuardianAssessment } from '../src/controller/guardian-assessment.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = process.env.CPA_CONFIG || path.resolve(repo, '..', 'CPA', 'config.yaml');
const config = fs.readFileSync(configFile, 'utf8');
const lines = config.split(/\r?\n/);
const offset = lines.findIndex((line) => /^\s*api-keys:\s*$/.test(line));
if (offset < 0) throw new Error('CPA client keys are not configured');
const first = lines.slice(offset + 1).find((line) => /^\s*-\s*\S+/.test(line));
if (!first) throw new Error('CPA client key is unavailable');
const apiKey = first.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, '');

const handle = '00000000-0000-4000-8000-000000000001';
const invoked = [];
const registry = new ToolRegistry();
for (const name of ['inspect_example_action', 'inspect_example_authorization']) {
  registry.register({
    name,
    description: 'Inspect only fixed mock evidence for the Guardian function-call protocol test.',
    inputSchema: { workspace_handle: z.string().uuid() },
    handler: async ({ workspace_handle: workspaceHandle }) => {
      if (workspaceHandle !== handle) throw new Error('Wrong fixture workspace');
      invoked.push(name);
      return {
        structuredContent: name === 'inspect_example_action'
          ? { command: 'git status --short', workspace: 'mock workspace', writes: false }
          : { user_requested: true, explicit_mock_only: true, approved: true },
      };
    },
  });
}
const dispatcher = new GuardianToolDispatcher({ registry });
const client = new CpaReviewClient({ apiKey, maxTurns: 5 });
const result = await client.complete({
  instructions: 'You are testing only an approval-review API function-call loop. Call both tools in the specified order over separate turns. Neither tool touches the filesystem. After both tool outputs are received, return strict JSON with outcome, risk_level, user_authorization and rationale. Never execute the command.',
  prompt: 'Call inspect_example_action first, wait for its result, then call inspect_example_authorization and wait for its result. Workspace handle for both is ' + handle + '. After both, allow the harmless mock git status action.',
  tools: dispatcher.availableTools(),
  schema: GUARDIAN_OUTPUT_SCHEMA,
  invokeTool: async (name, args, opts) => {
    try {
      return await dispatcher.invoke(name, args, {
        ...opts, workspaceHandle: handle, approvalId: 'fixture-review',
      });
    } catch (error) {
      console.log(JSON.stringify({ stage: 'tool_failed', tool: name,
        category: error?.name || 'Error',
        reason: String(error?.message || error).slice(0, 190) }));
      throw error;
    }
  },
  signal: AbortSignal.timeout(150_000),
});
const decision = parseGuardianAssessment(result.text);
const complete = invoked.length === 2 &&
  invoked[0] === 'inspect_example_action' &&
  invoked[1] === 'inspect_example_authorization' &&
  decision.outcome === 'allow';
console.log(JSON.stringify({
  complete, rounds: result.rounds, toolCalls: result.toolCalls,
  tools: invoked, outcome: decision.outcome,
}));
if (!complete) process.exitCode = 1;
