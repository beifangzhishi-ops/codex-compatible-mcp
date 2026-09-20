import { registerArchitectureTools } from './architecture-tools.mjs';
import { registerCoreTools } from './core-tools.mjs';
import { ToolRegistry } from './tool-registry.mjs';

export function createToolRegistry(runtime) {
  const registry = registerCoreTools(new ToolRegistry(), runtime);
  const { codeModeManager } = registerArchitectureTools(registry);
  return { registry, codeModeManager };
}
