import { registerCoreTools } from './core-tools.mjs';
import { registerSpecializedTools } from './specialized-tools.mjs';
import { registerPlanTools } from './plan-tools.mjs';
import { registerRestartTools } from './restart-tools.mjs';
import { registerCliTools } from './cli-tools.mjs';
import { ToolRegistry } from './tool-registry.mjs';

export function createToolRegistry(runtime) {
  const registry = registerCoreTools(new ToolRegistry(), runtime);
  registerPlanTools(registry, runtime);
  registerRestartTools(registry, runtime);
  registerSpecializedTools(registry, runtime);
  registerCliTools(registry, runtime);
  return { registry };
}
