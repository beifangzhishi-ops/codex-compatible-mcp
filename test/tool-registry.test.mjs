import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { ToolRegistry } from '../src/tools/tool-registry.mjs';

const makeTool = (name, namespace = 'ccm') => ({
  name,
  namespace,
  provider: 'test-provider',
  inputSchema: { value: z.string() },
  handler: async ({ value }) => ({
    content: [{ type: 'text', text: value }],
    structuredContent: { value },
  }),
});

test('all registered capabilities are top-level MCP peers without exposure tiers', () => {
  const registry = new ToolRegistry();
  const first = registry.register(makeTool('alpha'));
  const second = registry.register(makeTool('beta', 'ccm-extra'));
  assert.deepEqual(registry.list().map((tool) => tool.name), ['alpha', 'beta']);
  assert.equal(first.qualifiedName, 'ccm.alpha');
  assert.equal(second.qualifiedName, 'ccm-extra.beta');
  assert.equal(registry.get('alpha'), first);
  assert.equal(registry.get('ccm-extra.beta'), second);
  assert.equal(Object.hasOwn(first, 'exposure'), false);
  assert.equal(Object.hasOwn(first, 'surfaces'), false);
  assert.equal(registry.remove('alpha'), true);
  assert.deepEqual(registry.list().map((tool) => tool.name), ['beta']);
});

test('MCP wire names must be unique across namespaces', () => {
  const registry = new ToolRegistry();
  registry.register(makeTool('shared', 'first'));
  assert.throws(() => registry.register(makeTool('shared', 'second')), /wire-name collision/);
  assert.throws(() => registry.register(makeTool('shared', 'first')), /Tool collision/);
  assert.throws(() => registry.register({ name: 'missing_handler' }), /handler is required/);
});

test('registry validates arguments without nested dispatch or discovery', () => {
  const registry = new ToolRegistry();
  const tool = registry.register(makeTool('echo'));
  assert.deepEqual(registry.validateArguments(tool, { value: 'hello' }), { value: 'hello' });
  assert.throws(() => registry.validateArguments(tool, { value: 12 }));
  assert.throws(() => registry.validateArguments(tool, { value: 'ok', extra: true }));
});
