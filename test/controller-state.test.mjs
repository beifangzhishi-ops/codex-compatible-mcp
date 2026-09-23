import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  defaultControllerStateDir,
  defaultControllerStateFile,
} from '../src/controller/controller-state.mjs';

test('controller security state supports an explicit protected state directory', () => {
  const prior = process.env.CCM_CONTROLLER_STATE_DIR;
  process.env.CCM_CONTROLLER_STATE_DIR = path.resolve('C:\protected-ccm-state');
  try {
    assert.equal(
      defaultControllerStateDir(),
      path.resolve('C:\protected-ccm-state'),
    );
    assert.equal(
      defaultControllerStateFile('trusted-package-scripts.json'),
      path.join(
        path.resolve('C:\protected-ccm-state'),
        'trusted-package-scripts.json',
      ),
    );
  } finally {
    if (prior === undefined) delete process.env.CCM_CONTROLLER_STATE_DIR;
    else process.env.CCM_CONTROLLER_STATE_DIR = prior;
  }
});
