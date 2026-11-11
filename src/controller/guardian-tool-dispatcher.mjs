import * as z from 'zod/v4';
import { runReviewerTool } from './guardian-tool-context.mjs';

// Use the production model-visible ToolRegistry and its existing handlers.
// An internal reviewer invocation cannot mint an App approval or alter policy.
function isAppOnly(tool) {
  const visibility = tool.mcpMeta?.ui?.visibility || tool.ui?.visibility;
  return Array.isArray(visibility) && !visibility.includes('model');
}

function isStrictSchema(schema) {
  if (!schema || typeof schema !== 'object') return true;
  if (Array.isArray(schema)) return schema.every(isStrictSchema);
  if (schema.type === 'object' &&
      (schema.additionalProperties !== false ||
       !Array.isArray(schema.required) ||
       Object.keys(schema.properties || {}).some((key) => !schema.required.includes(key)))) {
    return false;
  }
  return Object.values(schema).every((value) => isStrictSchema(value));
}

export class GuardianToolDispatcher {
  constructor({ registry, audit = null } = {}) {
    this.registry = registry;
    this.audit = typeof audit === 'function' ? audit : null;
  }

  availableTools() {
    if (!this.registry) throw new Error('Guardian tool registry has not been attached');
    const tools = [];
    for (const tool of this.registry.list()) {
      if (isAppOnly(tool)) continue;
      try {
        const sourceSchema = typeof tool.inputSchema?.parse === 'function'
          ? tool.inputSchema : z.strictObject(tool.inputSchema || {});
        const schema = z.toJSONSchema(sourceSchema);
        delete schema.$schema;
        tools.push({
          type: 'function',
          name: tool.name,
          description: String(tool.description || tool.name).slice(0, 1000),
          strict: isStrictSchema(schema),
          parameters: schema,
        });
      } catch {
        this.audit?.({
          component: 'guardian', event: 'review_tool_schema_unavailable',
          tool_name: tool.name,
        });
        // Silent omission would violate the owner's same-tools decision.
        // Fail the review and allow the existing human approval fallback.
        throw new Error('Guardian cannot expose the registered tool schema for ' + tool.name);
      }
    }
    return tools;
  }

  async invoke(name, args, { approvalId, workspaceHandle, signal } = {}) {
    if (signal?.aborted) throw signal.reason || new Error('Guardian tool call cancelled');
    const tool = this.registry?.get(name);
    if (!tool || tool.name !== name || isAppOnly(tool)) {
      throw new Error('Guardian requested an unavailable tool');
    }
    const params = { ...args };
    // The reviewer is attached to the current action's workspace; a different
    // workspace handle is not an authority granted by a tool result.
    const schemaShape = tool.inputSchema?.shape || tool.inputSchema || {};
    if (Object.hasOwn(schemaShape, 'workspace_handle')) {
      if (params.workspace_handle && params.workspace_handle !== workspaceHandle) {
        throw new Error('Guardian tool workspace_handle differs from the reviewed action');
      }
      params.workspace_handle = workspaceHandle;
    }
    const validated = this.registry.validateArguments(tool, params);
    this.audit?.({
      component: 'guardian', event: 'review_tool_call', approval_id: approvalId,
      tool_name: name,
    });
    const result = await runReviewerTool(() => tool.handler(validated));
    if (signal?.aborted) throw signal.reason || new Error('Guardian tool call cancelled');
    const envelope = {
      isError: Boolean(result?.isError),
      ...(result?.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      content: (result?.content || []).map((part) => part.type === 'text'
        ? { type: 'text', text: String(part.text || '').slice(0, 12000) }
        : { type: part.type, note: 'Attached as a separate non-text tool result where supported' }),
    };
    const summary = JSON.stringify(envelope).slice(0, 20000);
    const images = (result?.content || []).filter((part) => part.type === 'image' &&
      /^image\/(?:png|jpeg|webp|gif)$/i.test(String(part.mimeType || '')) &&
      typeof part.data === 'string' && part.data.length <= 1_000_000);
    if (!images.length) return summary;
    // Responses function_call_output accepts text/image content arrays. The
    // reviewer keeps image inspection available under the same tool policy.
    return [
      { type: 'input_text', text: summary },
      ...images.map((part) => ({
        type: 'input_image',
        image_url: `data:${part.mimeType};base64,${part.data}`,
        detail: 'auto',
      })),
    ];
  }
}
