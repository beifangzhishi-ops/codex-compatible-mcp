import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { WORKSPACE_KEY_UI_HTML } from '../src/ui/workspace-key-app.mjs';

const PROJECT_KEY = '00000000-0000-4000-8000-000000000099';

function mountKeyCard() {
  const elements = Object.fromEntries(
    ['card', 'project', 'key', 'status', 'copy'].map((id) => [id, {
      hidden: id === 'card',
      textContent: '',
      addEventListener(event, callback) { this[event] = callback; },
    }]),
  );
  const listeners = {};
  const copied = [];
  const parent = { postMessage() {} };
  const window = {
    parent,
    navigator: { clipboard: { writeText: async (value) => { copied.push(value); } } },
    openai: { notifyIntrinsicHeight() {} },
    addEventListener(event, callback) { listeners[event] = callback; },
  };
  const script = WORKSPACE_KEY_UI_HTML.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    window,
    document: { getElementById: (id) => elements[id] },
    Map, Object, Error,
  });
  function result(value) {
    listeners.message({
      source: parent,
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: value } },
    });
  }
  return { elements, copied, result };
}

test('registered project key appears directly from CCM tool result and can be copied', async () => {
  const card = mountKeyCard();
  card.result({
    workspace_context: PROJECT_KEY,
    workspace_kind: 'registered',
    environment_id: '6v',
    workspace_id: 'project-a',
  });
  assert.equal(card.elements.card.hidden, false);
  assert.equal(card.elements.project.textContent, '6v / project-a');
  assert.equal(card.elements.key.textContent, PROJECT_KEY);
  await card.elements.copy.click();
  assert.deepEqual(card.copied, [PROJECT_KEY]);
});

test('projectless and incomplete or pending project actions never show a key', () => {
  const card = mountKeyCard();
  const complete = {
    workspace_context: PROJECT_KEY,
    workspace_kind: 'registered',
    environment_id: '6v',
    workspace_id: 'project-a',
  };
  for (const value of [
    { ...complete, workspace_kind: 'projectless' },
    { ...complete, approval_required: true },
    { ...complete, action_failed: true },
    { ...complete, workspace_context: undefined },
  ]) {
    card.result(complete);
    card.result(value);
    assert.equal(card.elements.card.hidden, true);
    assert.equal(card.elements.key.textContent, '');
  }
});
