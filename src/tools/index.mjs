import { registerArchitectureTools } from './architecture-tools.mjs';
import { registerCoreTools } from './core-tools.mjs';
import { registerSpecializedTools } from './specialized-tools.mjs';
import { registerPlanTools } from './plan-tools.mjs';
import { ToolRegistry } from './tool-registry.mjs';

export function createToolRegistry(runtime) {
  const registry = registerCoreTools(new ToolRegistry(), runtime);
  registerPlanTools(registry, runtime);
  registerSpecializedTools(registry, runtime);
  const { codeModeManager } = registerArchitectureTools(registry);
  return { registry, codeModeManager };
}
