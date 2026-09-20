import * as z from 'zod/v4';

export const ToolSurface = Object.freeze({
  DIRECT: 'direct',
  DEFERRED: 'deferred',
  CODE_MODE: 'code_mode',
});

function normalizedSurfaces(value = {}) {
  const surfaces = {
    direct: value.direct === true,
    deferred: value.deferred === true,
    codeMode: value.codeMode === true,
  };
  if (surfaces.direct && surfaces.deferred) {
    throw new Error('A tool cannot be both direct and deferred.');
  }
  return Object.freeze(surfaces);
}

export function toolExposureLabel(surfaces) {
  const { direct, deferred, codeMode } = surfaces;
  if (direct && codeMode) return 'Direct';
  if (direct) return 'DirectModelOnly';
  if (deferred && codeMode) return 'Deferred';
  if (deferred) return 'DeferredModelOnly';
  if (codeMode) return 'CodeModeOnly';
  return 'Hidden';
}

function qualifiedName(namespace, name) {
  return namespace ? namespace + '.' + name : name;
}

function inputJsonSchema(tool) {
  if (tool.inputJsonSchema) return structuredClone(tool.inputJsonSchema);
  if (tool.inputSchema && typeof tool.inputSchema.parse === 'function') {
    return z.toJSONSchema(tool.inputSchema);
  }
  return z.toJSONSchema(z.object(tool.inputSchema || {}));
}

function scoreTool(tool, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 1;

  const qualified = tool.qualifiedName.toLowerCase();
  const name = tool.name.toLowerCase();
  if (qualified === normalized || name === normalized) return 1000;
  if (qualified.startsWith(normalized) || name.startsWith(normalized)) return 500;

  const tokens = normalized
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter(Boolean);
  const haystack = [
    tool.qualifiedName,
    tool.name,
    tool.namespace,
    tool.provider,
    tool.description,
    ...(tool.tags || []),
  ].join(' ').toLowerCase();

  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) continue;
    matched += 1;
    score += name.includes(token) ? 50 : qualified.includes(token) ? 30 : 10;
  }
  if (matched === 0) return 0;
  // Prefer tools matching every term, but keep partial matches discoverable.
  return score + (matched === tokens.length ? 200 : matched * 5);
}

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool?.name) throw new Error('Tool name is required.');
    if (typeof tool.handler !== 'function') {
      throw new Error('Tool handler is required for ' + tool.name + '.');
    }

    const namespace = String(tool.namespace || 'ccm');
    const name = String(tool.name);
    const key = qualifiedName(namespace, name);
    if (this.tools.has(key)) {
      const existing = this.tools.get(key);
      throw new Error(
        'Tool collision for ' + key + ': ' +
        existing.provider + ' vs ' + (tool.provider || 'unknown'),
      );
    }

    const surfaces = normalizedSurfaces(
      tool.surfaces || { direct: true, codeMode: true },
    );

    if (surfaces.direct) {
      const conflict = [...this.tools.values()].find(
        (existing) => existing.surfaces.direct && existing.name === name,
      );
      if (conflict) {
        throw new Error(
          'Direct tool wire-name collision for ' + name + ': ' +
          conflict.qualifiedName + ' vs ' + key,
        );
      }
    }

    const normalized = Object.freeze({
      ...tool,
      name,
      namespace,
      qualifiedName: key,
      provider: String(tool.provider || 'ccm-core'),
      provenance: String(tool.provenance || tool.provider || 'ccm-core'),
      surfaces,
      exposure: toolExposureLabel(surfaces),
      tags: Object.freeze([...(tool.tags || [])].map(String)),
      environmentRequirements: Object.freeze({
        ...(tool.environmentRequirements || {}),
      }),
      supportsParallel: tool.supportsParallel === true,
      stability: String(tool.stability || 'stable'),
    });

    this.tools.set(key, normalized);
    return normalized;
  }

  get(identifier) {
    if (!identifier) return null;
    if (this.tools.has(identifier)) return this.tools.get(identifier);

    const matches = [...this.tools.values()].filter(
      (tool) => tool.name === identifier,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  resolve(identifier, { surface = null } = {}) {
    const direct = this.tools.get(identifier);
    const matches = direct
      ? [direct]
      : [...this.tools.values()].filter((tool) => tool.name === identifier);

    const available = surface
      ? matches.filter((tool) => this.isOnSurface(tool, surface))
      : matches;

    if (available.length === 1) return available[0];
    if (available.length === 0) return null;
    throw new Error(
      'Ambiguous tool name ' + identifier + ': ' +
      available.map((tool) => tool.qualifiedName).join(', '),
    );
  }

  remove(identifier) {
    const tool = this.get(identifier);
    if (!tool) return false;
    return this.tools.delete(tool.qualifiedName);
  }

  isOnSurface(tool, surface) {
    if (surface === ToolSurface.DIRECT) return tool.surfaces.direct;
    if (surface === ToolSurface.DEFERRED) return tool.surfaces.deferred;
    if (surface === ToolSurface.CODE_MODE) return tool.surfaces.codeMode;
    throw new Error('Unknown tool surface: ' + surface);
  }

  list({ surface = null } = {}) {
    const values = [...this.tools.values()];
    return surface
      ? values.filter((tool) => this.isOnSurface(tool, surface))
      : values;
  }

  listDirect() {
    return this.list({ surface: ToolSurface.DIRECT });
  }

  listDeferred() {
    return this.list({ surface: ToolSurface.DEFERRED });
  }

  listCodeMode() {
    return this.list({ surface: ToolSurface.CODE_MODE });
  }

  describe(tool) {
    return {
      name: tool.name,
      qualified_name: tool.qualifiedName,
      namespace: tool.namespace,
      provider: tool.provider,
      provenance: tool.provenance,
      description: tool.description || '',
      exposure: tool.exposure,
      surfaces: [
        ...(tool.surfaces.direct ? [ToolSurface.DIRECT] : []),
        ...(tool.surfaces.deferred ? [ToolSurface.DEFERRED] : []),
        ...(tool.surfaces.codeMode ? [ToolSurface.CODE_MODE] : []),
      ],
      input_schema: inputJsonSchema(tool),
      environment_requirements: tool.environmentRequirements,
      tags: [...tool.tags],
      stability: tool.stability,
    };
  }

  searchDeferred(query, { limit = 8 } = {}) {
    const capped = Math.max(1, Math.min(25, Number(limit) || 8));
    return this.listDeferred()
      .map((tool) => ({ tool, score: scoreTool(tool, String(query || '')) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) =>
        right.score - left.score ||
        left.tool.qualifiedName.localeCompare(right.tool.qualifiedName))
      .slice(0, capped)
      .map(({ tool }) => this.describe(tool));
  }

  validateArguments(tool, args) {
    if (typeof tool.validateArguments === 'function') {
      return tool.validateArguments(args ?? {});
    }
    if (tool.inputSchema && typeof tool.inputSchema.parse === 'function') {
      return tool.inputSchema.parse(args ?? {});
    }
    return z.object(tool.inputSchema || {}).strict().parse(args ?? {});
  }
}
