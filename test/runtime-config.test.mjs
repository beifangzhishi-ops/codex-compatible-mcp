import test from 'node:test';
import assert from 'node:assert/strict';
import { createControllerRuntime } from '../src/controller/runtime.mjs';
import { DEFAULT_APPROVAL_TTL_MS } from '../src/controller/approval-manager.mjs';

test('createControllerRuntime reads CCM_APPROVAL_TTL_MS', () => {
  const prior = process.env.CCM_APPROVAL_TTL_MS;
  try {
    process.env.CCM_APPROVAL_TTL_MS = '1800000';
    const runtime = createControllerRuntime({ workerPort: 0 });
    assert.equal(runtime.approvalManager.ttlMs, 1800000);

    process.env.CCM_APPROVAL_TTL_MS = 'invalid';
    const fallback = createControllerRuntime({ workerPort: 0 });
    assert.equal(fallback.approvalManager.ttlMs, DEFAULT_APPROVAL_TTL_MS);
  } finally {
    if (prior === undefined) delete process.env.CCM_APPROVAL_TTL_MS;
    else process.env.CCM_APPROVAL_TTL_MS = prior;
  }
});
