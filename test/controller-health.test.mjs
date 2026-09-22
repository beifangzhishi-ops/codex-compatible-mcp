import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpController } from '../src/controller/mcp-http-server.mjs';

function fakeRuntime() {
  return {
    environmentRegistry: {
      defaultEnvironmentId: 'local-test',
      listPublic() {
        return [];
      },
    },
    async close() {},
  };
}

test('controller health includes local Worker state from health provider', async () => {
  let state = 'connected';
  const controller = createHttpController({
    toolRegistry: { listDirect: () => [] },
    runtime: fakeRuntime(),
    host: '127.0.0.1',
    port: 0,
    healthProvider: () => ({
      status: state === 'connected' ? 'ok' : 'degraded',
      local_worker: {
        enabled: true,
        state,
        environment_id: 'local-test',
      },
    }),
  });

  await controller.start();
  try {
    const port = controller.address.port;
    let response = await fetch('http://127.0.0.1:' + port + '/ccm/health');
    let health = await response.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.local_worker.state, 'connected');

    state = 'restarting';
    response = await fetch('http://127.0.0.1:' + port + '/ccm/health');
    health = await response.json();
    assert.equal(health.status, 'degraded');
    assert.equal(health.local_worker.state, 'restarting');
  } finally {
    await controller.close();
  }
});
