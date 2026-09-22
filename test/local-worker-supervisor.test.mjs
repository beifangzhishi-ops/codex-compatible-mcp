import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { LocalWorkerSupervisor } from '../src/controller/local-worker-supervisor.mjs';

class FakeChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.killed = false;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  kill() {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', null, 'SIGTERM'));
  }
}

class FakeWorkerHub extends EventEmitter {
  constructor() {
    super();
    this.address = { port: 18301 };
    this.host = '127.0.0.1';
  }
  async waitForEnvironment() {
    return true;
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Condition was not met before timeout.');
}

test('local Worker supervisor respawns an unexpectedly exited Worker', async () => {
  const hub = new FakeWorkerHub();
  const children = [];
  const logs = [];
  const supervisor = new LocalWorkerSupervisor({
    workerHub: hub,
    environmentId: 'local-test',
    agentPath: 'agent.mjs',
    restartMinMs: 1,
    restartMaxMs: 5,
    log: (message) => logs.push(message),
    spawnProcess: () => {
      const child = new FakeChild(100 + children.length);
      children.push(child);
      return child;
    },
  });

  await supervisor.start();
  assert.equal(supervisor.status().state, 'connected');
  assert.equal(children.length, 1);

  children[0].emit('exit', 1, null);
  await waitFor(() => children.length === 2);
  hub.emit('environment_connected', 'local-test', 'local-test');
  assert.equal(supervisor.status().state, 'connected');
  assert.equal(supervisor.status().worker_pid, 101);
  assert.equal(supervisor.status().last_exit.code, 1);
  assert.equal(supervisor.status().restart_count, 1);
  assert.equal(supervisor.status().restart_attempts, 0);
  assert.ok(logs.some((line) => /restart scheduled/.test(line)));

  await supervisor.stop();
});

test('local Worker supervisor exposes reconnecting state and does not respawn on stop', async () => {
  const hub = new FakeWorkerHub();
  const children = [];
  const supervisor = new LocalWorkerSupervisor({
    workerHub: hub,
    environmentId: 'local-test',
    agentPath: 'agent.mjs',
    restartMinMs: 1,
    spawnProcess: () => {
      const child = new FakeChild(200 + children.length);
      children.push(child);
      return child;
    },
  });

  await supervisor.start();
  hub.emit('environment_disconnected', 'local-test', 'local-test');
  assert.equal(supervisor.status().state, 'reconnecting');

  await supervisor.stop();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(supervisor.status().state, 'stopped');
  assert.equal(children.length, 1);
});
