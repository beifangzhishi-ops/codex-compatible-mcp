import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { registerArchitectureTools } from '../src/tools/architecture-tools.mjs';
import {
  ToolRegistry,
  ToolSurface,
} from '../src/tools/tool-registry.mjs';

function textTool({
  name,
  namespace = 'test',
  surfaces,
  supportsParallel = false,
  description = '',
  inputSchema = {},
  handler,
  provider = 'test-provider',
  provenance = 'test-suite',
  tags = [],
  environmentRequirements = {},
}) {
  return {
    name,
    namespace,
    surfaces,
    supportsParallel,
    description,
    inputSchema,
    provider,
    provenance,
    tags,
    environmentRequirements,
    handler: handler || (async () => ({
      content: [{ type: 'text', text: name }],
    })),
  };
}

test('ToolRegistry derives exposure from independent surfaces', () => {
  const registry = new ToolRegistry();
  const direct = registry.register(textTool({
    name: 'direct',
    surfaces: { direct: true, codeMode: true },
  }));
  const directModelOnly = registry.register(textTool({
    name: 'direct_model_only',
    surfaces: { direct: true },
  }));
  const deferred = registry.register(textTool({
    name: 'deferred',
    surfaces: { deferred: true, codeMode: true },
  }));
  const deferredModelOnly = registry.register(textTool({
    name: 'deferred_model_only',
    surfaces: { deferred: true },
  }));
  const codeOnly = registry.register(textTool({
    name: 'code_only',
    surfaces: { codeMode: true },
  }));
  const hidden = registry.register(textTool({
    name: 'hidden',
    surfaces: {},
  }));

  assert.equal(direct.exposure, 'Direct');
  assert.equal(directModelOnly.exposure, 'DirectModelOnly');
  assert.equal(deferred.exposure, 'Deferred');
  assert.equal(deferredModelOnly.exposure, 'DeferredModelOnly');
  assert.equal(codeOnly.exposure, 'CodeModeOnly');
  assert.equal(hidden.exposure, 'Hidden');
  assert.deepEqual(
    registry.list({ surface: ToolSurface.DIRECT }).map((tool) => tool.name),
    ['direct', 'direct_model_only'],
  );
  assert.deepEqual(
    registry.listDeferred().map((tool) => tool.name).sort(),
    ['deferred', 'deferred_model_only'],
  );
  assert.deepEqual(
    registry.listCodeMode().map((tool) => tool.name).sort(),
    ['code_only', 'deferred', 'direct'],
  );
});


test('ToolRegistry enforces namespace and direct wire collisions', () => {
  const registry = new ToolRegistry();
  registry.register(textTool({
    name: 'same',
    namespace: 'alpha',
    surfaces: { direct: true },
    provider: 'provider-a',
  }));

  assert.throws(
    () => registry.register(textTool({
      name: 'same',
      namespace: 'beta',
      surfaces: { direct: true },
      provider: 'provider-b',
    })),
    /Direct tool wire-name collision/,
  );

  registry.register(textTool({
    name: 'nested',
    namespace: 'alpha',
    surfaces: { codeMode: true },
  }));
  registry.register(textTool({
    name: 'nested',
    namespace: 'beta',
    surfaces: { codeMode: true },
  }));

  assert.throws(
    () => registry.resolve('nested', { surface: ToolSurface.CODE_MODE }),
    /Ambiguous tool name/,
  );
  assert.equal(
    registry.resolve('alpha.nested', { surface: ToolSurface.CODE_MODE })
      .qualifiedName,
    'alpha.nested',
  );

  assert.throws(
    () => registry.register(textTool({
      name: 'nested',
      namespace: 'alpha',
      surfaces: {},
      provider: 'duplicate',
    })),
    /Tool collision/,
  );
});

test('tool_search metadata includes schema, provenance, and requirements', async () => {
  const registry = new ToolRegistry();
  registry.register(textTool({
    name: 'lookup',
    namespace: 'tickets',
    surfaces: { deferred: true, codeMode: true },
    supportsParallel: true,
    description: 'Lookup issue tickets by project and id.',
    tags: ['issues', 'tickets'],
    environmentRequirements: { capabilities: ['tickets'] },
    inputSchema: {
      project: z.string(),
      id: z.number().int(),
    },
    handler: async ({ project, id }) => ({
      content: [{ type: 'text', text: project + ':' + id }],
      structuredContent: { project, id },
    }),
  }));

  registerArchitectureTools(registry);
  const search = registry.get('tool_search');
  const result = await search.handler({ query: 'issue tickets', limit: 5 });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.count, 1);
  const [match] = result.structuredContent.tools;
  assert.equal(match.qualified_name, 'tickets.lookup');
  assert.equal(match.provenance, 'test-suite');
  assert.deepEqual(match.surfaces, ['deferred', 'code_mode']);
  assert.equal(match.input_schema.properties.project.type, 'string');
  assert.equal(match.input_schema.properties.id.type, 'integer');
  assert.deepEqual(match.environment_requirements, {
    capabilities: ['tickets'],
  });
});

test('tool_search tolerates punctuation and returns partial multi-term matches', async () => {
  const registry = new ToolRegistry();
  registry.register(textTool({
    name: 'quark_probe',
    namespace: 'ccm-extra',
    surfaces: { deferred: true, codeMode: true },
    tags: ['quark', 'cloud'],
  }));
  registry.register(textTool({
    name: 'bilibili_download_dash',
    namespace: 'ccm-extra',
    surfaces: { deferred: true, codeMode: true },
    tags: ['bilibili', 'video'],
  }));

  registerArchitectureTools(registry);
  const search = registry.get('tool_search');
  const result = await search.handler({ query: 'quark / bilibili', limit: 8 });

  assert.equal(result.structuredContent.count, 2);
  assert.deepEqual(
    result.structuredContent.tools.map((tool) => tool.qualified_name).sort(),
    ['ccm-extra.bilibili_download_dash', 'ccm-extra.quark_probe'],
  );
});


test('exec invokes deferred nested capabilities and wait resumes long cells', async () => {
  const registry = new ToolRegistry();

  registry.register(textTool({
    name: 'lookup',
    namespace: 'demo',
    surfaces: { deferred: true, codeMode: true },
    supportsParallel: true,
    inputSchema: { value: z.string() },
    handler: async ({ value }) => ({
      content: [{ type: 'text', text: 'lookup:' + value }],
      structuredContent: { value },
    }),
  }));

  registry.register(textTool({
    name: 'slow',
    namespace: 'demo',
    surfaces: { codeMode: true },
    supportsParallel: true,
    inputSchema: { delay_ms: z.number().int().min(1).max(1000) },
    handler: async ({ delay_ms: delayMs }) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        content: [{ type: 'text', text: 'slow-done' }],
        structuredContent: { done: true },
      };
    },
  }));

  const { codeModeManager } = registerArchitectureTools(registry);
  const exec = registry.get('exec');
  const wait = registry.get('wait');

  const immediate = await exec.handler({
    calls: [{
      tool: 'demo.lookup',
      arguments: { value: 'abc' },
    }],
    yield_time_ms: 1000,
  });
  assert.equal(immediate.isError, undefined);
  assert.equal(immediate.structuredContent.state, 'completed');
  assert.equal(immediate.structuredContent.calls.length, 1);
  assert.equal(
    immediate.structuredContent.calls[0].result.structured_content.value,
    'abc',
  );

  const yielded = await exec.handler({
    calls: [{
      tool: 'demo.slow',
      arguments: { delay_ms: 80 },
    }],
    yield_time_ms: 0,
  });
  assert.equal(yielded.structuredContent.state, 'running');
  assert.equal(typeof yielded.structuredContent.cell_id, 'string');

  const resumed = await wait.handler({
    cell_id: yielded.structuredContent.cell_id,
    yield_time_ms: 1000,
  });
  assert.equal(resumed.isError, undefined);
  assert.equal(resumed.structuredContent.state, 'completed');
  assert.equal(resumed.structuredContent.calls.length, 1);
  assert.match(
    resumed.structuredContent.calls[0].result.content[0].text,
    /slow-done/,
  );

  codeModeManager.close();
});

test('exec rejects unsafe parallelization and reports live nested sessions clearly', async () => {
  const registry = new ToolRegistry();

  registry.register(textTool({
    name: 'serial_mutation',
    namespace: 'demo',
    surfaces: { codeMode: true },
    supportsParallel: false,
    handler: async () => ({
      content: [{ type: 'text', text: 'mutated' }],
    }),
  }));

  registry.register(textTool({
    name: 'live_process',
    namespace: 'demo',
    surfaces: { codeMode: true },
    supportsParallel: true,
    handler: async () => ({
      content: [{ type: 'text', text: 'started' }],
      structuredContent: { session_id: 77, output: 'started' },
    }),
  }));

  registerArchitectureTools(registry);
  const exec = registry.get('exec');

  const rejected = await exec.handler({
    calls: [{ tool: 'demo.serial_mutation', arguments: {} }],
    parallel: true,
  });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /parallel-call support/);

  const live = await exec.handler({
    calls: [{ tool: 'demo.live_process', arguments: {} }],
    yield_time_ms: 1000,
  });
  assert.equal(live.isError, undefined);
  assert.equal(live.structuredContent.state, 'awaiting_io');
  assert.equal(live.structuredContent.live_sessions[0].session_id, 77);
  assert.equal(live.structuredContent.next_operation, 'write_stdin');
  assert.match(live.structuredContent.message, /still running/);

  assert.notEqual(live.structuredContent.state, 'completed');
});

test('wait defaults to a short poll and rejects waits above 30 seconds', async () => {
  const registry = new ToolRegistry();
  registry.register(textTool({
    name: 'slow_wait',
    namespace: 'demo',
    surfaces: { codeMode: true },
    supportsParallel: true,
    inputSchema: { delay_ms: z.number().int().min(1).max(10_000) },
    handler: async ({ delay_ms: delayMs }) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { content: [{ type: 'text', text: 'done' }] };
    },
  }));

  const { codeModeManager } = registerArchitectureTools(registry);
  try {
    const exec = registry.get('exec');
    const wait = registry.get('wait');
    assert.throws(
      () => registry.validateArguments(wait, {
        cell_id: 'test-cell',
        yield_time_ms: 30_001,
      }),
      /30000/,
    );

    const yielded = await exec.handler({
      calls: [{ tool: 'demo.slow_wait', arguments: { delay_ms: 6000 } }],
      yield_time_ms: 0,
    });
    const startedAt = Date.now();
    const polled = await wait.handler({
      cell_id: yielded.structuredContent.cell_id,
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(polled.structuredContent.state, 'running');
    assert.ok(elapsed >= 4500 && elapsed < 5800, 'default wait should be about 5 seconds');

    const completed = await wait.handler({
      cell_id: yielded.structuredContent.cell_id,
      yield_time_ms: 2000,
    });
    assert.equal(completed.structuredContent.state, 'completed');
  } finally {
    codeModeManager.close();
  }
});


test('exec bounds oversized nested tool results before MCP transport', async () => {
  const registry = new ToolRegistry();
  registry.register(textTool({
    name: 'oversized',
    namespace: 'demo',
    surfaces: { deferred: true, codeMode: true },
    handler: async () => ({
      content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1000) }],
    }),
  }));

  const { codeModeManager } = registerArchitectureTools(registry);
  try {
    const exec = registry.get('exec');
    const result = await exec.handler({
      calls: [{ tool: 'demo.oversized', arguments: {} }],
      yield_time_ms: 1000,
    });

    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.state, 'completed');
    assert.equal(result.structuredContent.has_errors, true);
    assert.equal(result.structuredContent.calls[0].result.is_error, true);
    assert.match(
      result.structuredContent.calls[0].result.content[0].text,
      /1 MiB Code Mode input limit/,
    );
  } finally {
    codeModeManager.close();
  }
});
