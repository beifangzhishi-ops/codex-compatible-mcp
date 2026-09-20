export const ToolExposure = Object.freeze({
  DIRECT: 'direct',
  DEFERRED: 'deferred',
  CODE_MODE_ONLY: 'code_mode_only',
  HIDDEN: 'hidden',
});

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(tool) {
    if (!tool?.name) throw new Error('Tool name is required.');
    if (this.tools.has(tool.name)) {
      const existing = this.tools.get(tool.name);
      throw new Error(
        `Tool collision for ${tool.name}: ${existing.provider} vs ${tool.provider || 'unknown'}`,
      );
    }
    const normalized = {
      exposure: ToolExposure.DIRECT,
      provider: 'ccm-core',
      namespace: 'ccm',
      ...tool,
    };
    this.tools.set(normalized.name, normalized);
    return normalized;
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  list({ exposure = null } = {}) {
    const values = [...this.tools.values()];
    return exposure ? values.filter((tool) => tool.exposure === exposure) : values;
  }

  listDirect() {
    return this.list({ exposure: ToolExposure.DIRECT });
  }
}
