import * as z from 'zod/v4';

function qualifiedName(namespace, name) {
  return namespace ? namespace + '.' + name : name;
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
      throw new Error('Tool collision for ' + key + ': ' +
        this.tools.get(key).provider + ' vs ' + (tool.provider || 'unknown'));
    }
    const wireConflict = [...this.tools.values()].find((item) => item.name === name);
    if (wireConflict) {
      throw new Error('MCP wire-name collision for ' + name + ': ' +
        wireConflict.qualifiedName + ' vs ' + key);
    }

    const normalized = Object.freeze({
      ...tool,
      name,
      namespace,
      qualifiedName: key,
      provider: String(tool.provider || 'ccm-core'),
      provenance: String(tool.provenance || tool.provider || 'ccm-core'),
      tags: Object.freeze([...(tool.tags || [])].map(String)),
      environmentRequirements: Object.freeze({ ...(tool.environmentRequirements || {}) }),
    });
    this.tools.set(key, normalized);
    return normalized;
  }

  get(identifier) {
    if (!identifier) return null;
    return this.tools.get(identifier) ||
      [...this.tools.values()].find((tool) => tool.name === identifier) || null;
  }

  remove(identifier) {
    const tool = this.get(identifier);
    return tool ? this.tools.delete(tool.qualifiedName) : false;
  }

  list() {
    return [...this.tools.values()];
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
