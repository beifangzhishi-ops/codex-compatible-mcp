import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { VerificationInputManager } from '../src/controller/verification-input-manager.mjs';
import {
  VERIFICATION_INPUT_UI_HTML,
  VERIFICATION_INPUT_UI_URI,
} from '../src/ui/verification-input-app.mjs';
import { registerCoreTools } from '../src/tools/core-tools.mjs';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';
import { RemoteProcessManager } from '../src/runtime/remote-process-manager.mjs';

const HANDLE = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = 1005;
const EXAMPLE = 'TEST_VALUE_NOT_AN_OTP';

function fixture() {
  let live = true;
  let calls = [];
  const processManager = {
    isSessionLive: (id, handle) => live && id === SESSION_ID && handle === HANDLE,
    sessionMetadata: (id) => id === SESSION_ID ? {
      session_id: id,
      environment_id: 'fixture-worker',
      workspace_id: 'fixture-project',
      workspace_handle: HANDLE,
    } : null,
    writeVerificationInput: async (args) => {
      calls.push(args);
      return { session_running: true };
    },
  };
  const manager = new VerificationInputManager({ processManager });
  return { manager, processManager, getCalls: () => calls, setLive: (x) => { live = x; } };
}

test('verification input is routed only to the owning live process and never returned', async () => {
  const { manager, getCalls, setLive } = fixture();
  assert.throws(() => manager.create({
    workspaceHandle: '00000000-0000-4000-8000-000000000002',
    sessionId: SESSION_ID,
  }), /No live CCM process/);
  assert.throws(() => manager.create({
    workspaceHandle: HANDLE, sessionId: 1234,
  }), /No live CCM process/);
  const created = manager.create({
    workspaceHandle: HANDLE,
    sessionId: SESSION_ID,
    hostSession: 'host-A',
  });
  assert.equal(created.state, 'pending');
  assert.equal(JSON.stringify(created).includes(EXAMPLE), false);
  assert.throws(() => manager.status(created.request_id, {
    hostSession: 'host-B',
  }), /another Host session/);
  const first = await manager.submit(created.request_id, EXAMPLE, {
    hostSession: 'host-A',
  });
  assert.equal(first.state, 'delivered');
  assert.equal(first.session_running, true);
  assert.deepEqual(getCalls(), [{
    session_id: SESSION_ID, workspace_handle: HANDLE, value: EXAMPLE,
  }]);
  assert.equal(JSON.stringify(first).includes(EXAMPLE), false);
  const second = await manager.submit(created.request_id, EXAMPLE);
  assert.equal(second.state, 'delivered');
  assert.equal(getCalls().length, 1, 'one input card can only write once');
  const pending = manager.create({ workspaceHandle: HANDLE, sessionId: SESSION_ID });
  setLive(false);
  assert.equal(manager.status(pending.request_id).state, 'unavailable');
  manager.close();
  assert.throws(() => manager.status(created.request_id), /no longer available/);
});

test('uncertain delivery cannot be retried automatically or expose input in error', async () => {
  const { manager, processManager } = fixture();
  let count = 0;
  processManager.writeVerificationInput = async () => {
    count++;
    throw new Error('Unexpected echo: ' + EXAMPLE);
  };
  const request = manager.create({ workspaceHandle: HANDLE, sessionId: SESSION_ID });
  const result = await manager.submit(request.request_id, EXAMPLE);
  assert.equal(result.state, 'unknown');
  assert.equal(JSON.stringify(result).includes(EXAMPLE), false);
  await manager.submit(request.request_id, EXAMPLE);
  assert.equal(count, 1);
});

test('Worker echo is masked in both the immediate input and subsequent model poll', async () => {
  const sent = [];
  const workerHub = {
    on() {}, off() {},
    async call(environment, method, args) {
      sent.push({ environment, method, args });
      return { session_id: 75, output: 'Echo: ' + EXAMPLE + '\r\n' };
    },
  };
  const processManager = new RemoteProcessManager({
    environmentRegistry: {},
    workerHub,
    workspaceHandleManager: { resolve: () => ({ workspace_handle: HANDLE }) },
  });
  processManager.sessions.set(SESSION_ID, {
    environmentId: 'fixture-worker',
    remoteSessionId: 75,
    workspaceHandle: HANDLE,
    workspace: { workspace_handle: HANDLE },
    tty: true,
    verificationEchoes: [],
  });
  const result = await processManager.writeVerificationInput({
    session_id: SESSION_ID, workspace_handle: HANDLE, value: EXAMPLE,
  });
  assert.deepEqual(result, { session_running: true });
  assert.equal(sent[0].args.chars, EXAMPLE + '\r');
  const poll = await processManager.writeStdin({
    session_id: SESSION_ID, workspace_handle: HANDLE, chars: '',
  });
  assert.equal(poll.output.includes(EXAMPLE), false);
  assert.match(poll.output, /\[verification input\]/);
  await processManager.close();
});

test('verification card delivers value via app-only call, but context and chat never contain it', async () => {
  const script = VERIFICATION_INPUT_UI_HTML.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.equal(VERIFICATION_INPUT_UI_URI, 'ui://ccm/verification-input-v1.html');
  const handlers = new Map();
  const calls = [];
  const elements = new Map();
  for (const id of ['card', 'title', 'target', 'form', 'value', 'send', 'status']) {
    elements.set(id, {
      hidden: false, disabled: false, textContent: '', value: '',
      addEventListener(name, handler) { handlers.set(id + ':' + name, handler); },
    });
  }
  const events = new Map();
  const card = {
    request_id: '00000000-0000-4000-8000-000000000003',
    environment_id: 'fixture-worker',
    workspace_id: 'fixture-project',
    session_id: SESSION_ID,
    state: 'pending',
  };
  const parent = { postMessage(message) {
    calls.push(message);
    if (!Object.hasOwn(message, 'id')) return;
    const result = message.method === 'ui/initialize'
      ? { hostCapabilities: { message: { text: true } } }
      : message.method === 'tools/call'
        ? { structuredContent: {
            ...card,
            state: message.params.name === 'submit_verification_input' ? 'delivered' : 'pending',
          } }
        : {};
    queueMicrotask(() => {
      for (const cb of events.get('message') || []) {
        cb({ source: parent, data: { jsonrpc: '2.0', id: message.id, result } });
      }
    });
  } };
  const window = {
    parent,
    openai: { toolOutput: card, notifyIntrinsicHeight() {} },
    addEventListener(type, callback) {
      events.set(type, [...(events.get(type) || []), callback]);
    },
  };
  vm.runInNewContext(script, {
    window, document: { getElementById: (id) => elements.get(id) },
    setTimeout, clearTimeout, console,
  });
  async function until(predicate) {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.fail('Timed out waiting for MCP App call');
  }
  await until(() => calls.some((c) => c.params?.name === 'get_verification_input_status'));
  elements.get('value').value = EXAMPLE;
  handlers.get('value:input')();
  handlers.get('form:submit')({ preventDefault() {} });
  await until(() => calls.some((c) => c.method === 'ui/message'));
  const continuation = calls.find((c) => c.method === 'ui/message');
  assert.match(continuation.params.content[0].text, /I submitted the verification input through the CCM card/);
  assert.match(continuation.params.content[0].text, /without checking the code or its submission status/);
  const submit = calls.filter((c) => c.params?.name === 'submit_verification_input');
  assert.equal(submit.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(submit[0].params.arguments)), {
    request_id: card.request_id, value: EXAMPLE,
  });
  assert.equal(elements.get('value').value, '');
  for (const call of calls.filter((c) =>
    c.method !== 'tools/call' || c.params?.name !== 'submit_verification_input')) {
    assert.equal(JSON.stringify(call).includes(EXAMPLE), false);
  }
  assert.equal(elements.get('form').hidden, true);
});

test('verification tool metadata hides submitted values from the model-facing surface', async () => {
  const { manager } = fixture();
  const registry = registerCoreTools(new ToolRegistry(), { verificationInputManager: manager });
  const request = await registry.get('request_verification_input').handler({
    workspace_handle: HANDLE, session_id: SESSION_ID,
  });
  assert.equal(request.structuredContent.state, 'pending');
  assert.match(request.content[0].text, /Wait for the card's automatic code-free continuation/);
  assert.match(registry.get('request_verification_input').description, /on that follow-up, assume the code has been submitted/);
  const submitTool = registry.get('submit_verification_input');
  assert.deepEqual(submitTool.mcpMeta.ui.visibility, ['app']);
  assert.deepEqual(registry.get('get_verification_input_status').mcpMeta.ui.visibility, ['app']);
  const response = await submitTool.handler({
    request_id: request.structuredContent.request_id, value: EXAMPLE,
  });
  assert.equal(response.structuredContent.state, 'delivered');
  assert.equal(JSON.stringify(response).includes(EXAMPLE), false);
});
