import { createRuntime } from './runtime/index.mjs';
import { ToolRegistry } from './tools/tool-registry.mjs';
import { registerCoreTools } from './tools/core-tools.mjs';
import { createHttpController } from './controller/mcp-http-server.mjs';

const runtime = createRuntime();
const toolRegistry = registerCoreTools(new ToolRegistry(), runtime);
const controller = createHttpController({ toolRegistry, runtime });

await controller.start();
console.log(`CCM listening at ${controller.endpoint}`);

async function shutdown() {
  await controller.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
