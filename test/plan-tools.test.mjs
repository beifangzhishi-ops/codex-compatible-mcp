import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlanManager } from '../src/controller/plan-manager.mjs';
import { registerPlanTools } from '../src/tools/plan-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

test('Plan tools are peers, carry ids explicitly, and keep reads lifecycle-neutral', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-plan-tools-'));
  const planManager = new PlanManager({ stateDir: root });
  const registry = registerPlanTools(new ToolRegistry(), { planManager });
  try {
    const patchTool = registry.get('ccm.plan_patch');
    const readTool = registry.get('ccm.plan_read');
    assert.deepEqual(registry.list().map((tool) => tool.name), ['plan_patch', 'plan_read']);
    assert.match(patchTool.description, /Planning guidance/);
    assert.match(patchTool.description, /explore first, ask second/i);
    assert.match(patchTool.description, /Do not ask the user for facts reasonably discoverable/i);
    assert.match(patchTool.description, /Bias toward questions over guessing/i);
    assert.match(patchTool.description, /2-4 mutually exclusive choices/i);
    assert.match(patchTool.description, /user-visible question/i);
    assert.match(patchTool.description, /recommended default.*same user-visible question/i);
    assert.match(patchTool.description, /accept other answers/i);
    assert.match(patchTool.description, /Planning mutation boundary/i);
    assert.match(patchTool.description, /do not edit tracked project files/i);
    assert.match(patchTool.description, /Decision-complete Plan/i);
    assert.match(patchTool.description, /without inventing product decisions/i);
    assert.match(patchTool.description, /Final Plan handoff/i);
    assert.match(patchTool.description, /ccm-extra\.publish with plan_id alone/i);
    assert.match(patchTool.description, /immutable Markdown snapshot/i);
    assert.match(patchTool.description, /summarize rather than reading\/pasting the entire Plan/i);
    assert.match(patchTool.description, /Later plan_read during implementation remains lifecycle-neutral/i);
    assert.match(patchTool.description, /Keep the durable Plan current/);
    assert.match(patchTool.description, /Execution gate/);
    assert.match(patchTool.description, /workspace\/sandbox approvals/);
    assert.match(patchTool.description, /do not count as execution authorization/);
    assert.match(readTool.description, /lifecycle-neutral/);

    const created = (await patchTool.handler({
      patch: [
            '*** Begin Patch',
            '*** Add File: plan.md',
            '+# Durable plan',
            '+',
            '+send_file decision',
            '*** End Patch',
      ].join('\n'),
    })).structuredContent;
    const planId = created.plan_id;

    const read = await readTool.handler({ plan_id: planId, query: 'send_file' });
    assert.match(read.content[0].text, /line 3/i);
    assert.equal(read.structuredContent.matches[0].line, 3);

    assert.throws(
      () => registry.validateArguments(readTool, {
        plan_id: planId,
        query: 'x',
        start_line: 1,
      }),
      /mutually exclusive/,
    );
    assert.throws(
      () => registry.validateArguments(readTool, {
        plan_id: planId,
        start_line: 5,
        end_line: 2,
      }),
      /start_line must be less than or equal to end_line/,
    );
  } finally {
    planManager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
