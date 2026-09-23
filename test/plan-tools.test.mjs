import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlanManager } from '../src/controller/plan-manager.mjs';
import { registerPlanTools } from '../src/tools/plan-tools.mjs';
import { registerArchitectureTools } from '../src/tools/architecture-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

test('Plan tools stay deferred, carry ids explicitly, and keep reads lifecycle-neutral', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-plan-tools-'));
  const planManager = new PlanManager({ stateDir: root });
  const registry = registerPlanTools(new ToolRegistry(), { planManager });
  const { codeModeManager } = registerArchitectureTools(registry);
  try {
    const patchTool = registry.get('ccm.plan_patch');
    const readTool = registry.get('ccm.plan_read');
    assert.equal(patchTool.surfaces.direct, false);
    assert.equal(patchTool.surfaces.deferred, true);
    assert.equal(patchTool.surfaces.codeMode, true);
    assert.equal(readTool.surfaces.direct, false);
    assert.equal(readTool.surfaces.deferred, true);
    assert.equal(readTool.surfaces.codeMode, true);
    assert.match(patchTool.description, /Planning guidance/);
    assert.match(patchTool.description, /Keep the durable Plan current/);
    assert.match(patchTool.description, /Execution gate/);
    assert.match(patchTool.description, /workspace approval/);
    assert.match(patchTool.description, /does not count as execution authorization/);
    assert.match(readTool.description, /lifecycle-neutral/);

    const search = await registry.get('ccm.tool_search').handler({ query: 'plan patch' });
    assert.ok(search.structuredContent.tools.some((tool) => tool.qualified_name === 'ccm.plan_patch'));

    const createdCell = await registry.get('ccm.exec').handler({
      calls: [{
        tool: 'ccm.plan_patch',
        arguments: {
          patch: [
            '*** Begin Patch',
            '*** Add File: plan.md',
            '+# Durable plan',
            '+',
            '+send_file decision',
            '*** End Patch',
          ].join('\n'),
        },
      }],
      yield_time_ms: 1000,
    });
    assert.equal(createdCell.structuredContent.state, 'completed');
    const created = createdCell.structuredContent.calls[0].result.structured_content;
    const planId = created.plan_id;

    const readCell = await registry.get('ccm.exec').handler({
      calls: [{
        tool: 'ccm.plan_read',
        arguments: { plan_id: planId, query: 'send_file' },
      }],
      yield_time_ms: 1000,
    });
    assert.equal(readCell.structuredContent.state, 'completed');
    const read = readCell.structuredContent.calls[0].result;
    assert.match(read.content[0].text, /line 3/i);
    assert.equal(read.structured_content.matches[0].line, 3);

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
    codeModeManager.close();
    planManager.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
