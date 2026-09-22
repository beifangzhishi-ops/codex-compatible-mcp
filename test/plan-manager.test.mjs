import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlanManager } from '../src/controller/plan-manager.mjs';

function addPatch(lines) {
  return [
    '*** Begin Patch',
    '*** Add File: plan.md',
    ...lines.map((line) => '+' + line),
    '*** End Patch',
  ].join('\n');
}

function updatePatch(from, to) {
  return [
    '*** Begin Patch',
    '*** Update File: plan.md',
    '@@',
    '-' + from,
    '+' + to,
    '*** End Patch',
  ].join('\n');
}

test('PlanManager creates, patches, reads, searches, and survives restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-plans-'));
  try {
    const manager = new PlanManager({ stateDir: root });
    const created = await manager.create(addPatch(['# Plan', '', 'alpha target']));
    assert.match(created.plan_id, /^[0-9a-f-]{36}$/i);

    const full = await manager.read(created.plan_id);
    assert.equal(full.mode, 'full');
    assert.equal(full.content, '# Plan\n\nalpha target');
    assert.equal(full.truncated, false);

    await manager.patch(created.plan_id, updatePatch('alpha target', 'beta target'));
    const search = await manager.read(created.plan_id, { query: 'BETA' });
    assert.equal(search.mode, 'search');
    assert.equal(search.total_matches, 1);
    assert.equal(search.matches[0].line, 3);
    assert.equal(search.matches[0].text, 'beta target');
    assert.ok(search.matches[0].context.some((line) => line.line === 3));

    const range = await manager.read(created.plan_id, { startLine: 2, endLine: 3 });
    assert.equal(range.mode, 'range');
    assert.equal(range.start_line, 2);
    assert.equal(range.end_line, 3);
    assert.equal(range.content, '\nbeta target');

    manager.close();
    const restarted = new PlanManager({ stateDir: root });
    const afterRestart = await restarted.read(created.plan_id);
    assert.match(afterRestart.content, /beta target/);
    restarted.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('PlanManager enforces virtual plan.md forms and preserves content on failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-plan-patch-'));
  try {
    const manager = new PlanManager({ stateDir: root });
    await assert.rejects(
      manager.create([
        '*** Begin Patch',
        '*** Add File: other.md',
        '+wrong',
        '*** End Patch',
      ].join('\n')),
      /patch target must be 'plan\.md'/,
    );
    const beforeCreate = await fs.readdir(root).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(beforeCreate, []);

    const created = await manager.create(addPatch(['one']));
    await assert.rejects(
      manager.patch(created.plan_id, addPatch(['replacement'])),
      /must use Update File/,
    );
    await assert.rejects(
      manager.patch(created.plan_id, updatePatch('missing', 'changed')),
      /target lines were not found/,
    );
    assert.equal((await manager.read(created.plan_id)).content, 'one');
    await assert.rejects(
      manager.read('00000000-0000-4000-8000-000000000000'),
      /Unknown plan_id/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('PlanManager serializes same-plan writes and bounds long reads/searches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-plan-bounds-'));
  try {
    const manager = new PlanManager({ stateDir: root });
    const lines = Array.from({ length: 450 }, (_, index) =>
      index === 0 ? 'alpha' : 'line ' + (index + 1) + (index < 30 ? ' hit' : ''),
    );
    const created = await manager.create(addPatch(lines));

    await Promise.all([
      manager.patch(created.plan_id, updatePatch('alpha', 'beta')),
      manager.patch(created.plan_id, updatePatch('beta', 'gamma')),
    ]);
    assert.match((await manager.read(created.plan_id, { startLine: 1, endLine: 1 })).content, /gamma/);

    const full = await manager.read(created.plan_id);
    assert.equal(full.end_line, 400);
    assert.equal(full.truncated, true);
    assert.equal(full.next_start_line, 401);

    const search = await manager.read(created.plan_id, { query: 'hit' });
    assert.equal(search.total_matches, 29);
    assert.equal(search.matches.length, 20);
    assert.equal(search.truncated, true);
    assert.equal(search.matches[0].line, 2);

    const huge = await manager.create(addPatch(['x'.repeat(40_000) + ' needle']));
    const hugeRead = await manager.read(huge.plan_id);
    assert.equal(hugeRead.truncated, true);
    assert.equal(hugeRead.line_truncated, true);
    assert.ok(hugeRead.content.length <= 32_000);
    const hugeSearch = await manager.read(huge.plan_id, { query: 'needle' });
    assert.equal(hugeSearch.matches[0].line, 1);
    assert.equal(hugeSearch.matches[0].text_truncated, true);
    assert.ok(hugeSearch.matches[0].text.length <= 1_001);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
