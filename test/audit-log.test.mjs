import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAuditLogger } from '../src/controller/audit-log.mjs';

test('audit logger writes structured correlation fields without adding command output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ccm-audit-'));
  const file = path.join(root, 'audit.log');
  try {
    const audit = createAuditLogger({
      file,
      now: () => new Date('2026-09-23T07:00:00.000Z'),
    });
    audit({
      component: 'approval',
      event: 'dispatching',
      approval_id: 'approval-1',
      operation_id: 'operation-1',
      environment_id: 'worker-a',
      workspace_context: 'workspace-context-a',
      intent_sha256: 'a'.repeat(64),
    });

    const lines = (await fs.readFile(file, 'utf8')).trim().split(/\r?\n/u);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.timestamp, '2026-09-23T07:00:00.000Z');
    assert.equal(record.operation_id, 'operation-1');
    assert.equal(record.approval_id, 'approval-1');
    assert.equal(record.intent_sha256, 'a'.repeat(64));
    assert.equal(Object.hasOwn(record, 'cmd'), false);
    assert.equal(Object.hasOwn(record, 'output'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
