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
    assert.match(patchTool.description, /Explore discoverable facts before asking/);
    assert.match(patchTool.description, /2-4 meaningful options and a recommended default/);
    assert.match(patchTool.description, /decision-complete but concise Plan/);
    assert.match(patchTool.description, /3-5 short sections/);
    assert.match(patchTool.description, /Group changes by behavior\/subsystem rather than file inventory/);
    assert.match(patchTool.description, /normally at most 3 paths/);
    assert.match(patchTool.description, /unnecessary schemas\/fallbacks, speculative edge cases, and defensive prose/);
    assert.match(patchTool.description, /non-mutating validation/);
    assert.match(patchTool.description, /without explicit implementation authorization/);
    assert.match(patchTool.description, /Do not assume historical compatibility/);
    assert.match(patchTool.description, /publish plan_id alone through ccm-extra\.publish/);
    assert.match(patchTool.description, /inspect returned screenshots/);
    assert.match(patchTool.description, /summarize without pasting the Plan/);
    assert.match(patchTool.description, /workspace\/sandbox approvals do not authorize implementation/);
    assert.match(patchTool.description, /plan_read remains lifecycle-neutral/);
    assert.ok(patchTool.description.length < 1450, 'Plan guidance should stay compact');
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
