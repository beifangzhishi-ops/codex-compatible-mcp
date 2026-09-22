import { randomUUID } from 'node:crypto';
import {
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  guardMcpToolResult,
  resolveMaxMcpFileResultBytes,
  resolveMaxMcpToolResultBytes,
} from './response-guard.mjs';
import {
  EXEC_IMAGE_BRIDGE_UI_URI,
  VIEW_IMAGE_LEGACY_UI_URI,
  VIEW_IMAGE_UI_HTML,
  VIEW_IMAGE_UI_URI,
  VIEW_IMAGE_V6_UI_URI,
  VIEW_IMAGE_V5_UI_URI,
  VIEW_IMAGE_V4_UI_URI,
  VIEW_IMAGE_V3_UI_URI,
  VIEW_IMAGE_V2_UI_URI,
} from '../ui/view-image-app.mjs';

const SERVER_INFO = { name: 'ccm', version: '0.1.0' };

function createProtocolServer(
  toolRegistry,
  runtime,
  maxToolResultBytes,
  maxFileResultBytes,
) {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: { listChanged: true } },
    instructions: [
      'CCM is a Codex-compatible execution harness.',
      'Use exec_command for shell/repository work and write_stdin for live sessions.',
      'Use list_environments when environment selection is unclear.',
      'Use tool_search to discover deferred capabilities without expanding the top-level MCP schema.',
      'Use exec/wait for structured nested capability dispatch; host Code Mode remains responsible for JavaScript/control flow.',
      'For multi-step CCM work, prefer one exec call containing Code Mode-enabled core tools such as list_environments, exec_command, write_stdin, and apply_patch (plus deferred tools when needed). This reduces repeated host MCP initialization round trips. Use parallel=true only for independent calls.',
      'Commands run under the selected environment permission profile.',
      'CCM error semantics: distinguish CCM results from host/tool-call failures. A normal CCM exec_command result contains CCM fields such as chunk_id, wall_time_seconds, output, exit_code/session_id, or approval_required. If the host returns a Script error or other failure without a CCM structured result, do not attribute it to CCM: the command may not have been dispatched to the CCM worker.',
      'CCM itself does not perform or report GPT/OpenAI safety review. Do not describe host-side safety/policy/tool-call errors as CCM refusals. Only describe a refusal as CCM-originated when CCM returns an explicit CCM error/result that says so.',
      'Runtime, shell, path, non-zero exit, timeout, network, HTTP, DNS, proxy, and target-site errors are execution/target failures, not CCM safety refusals. Verify the relevant layer before assigning a cause.',
      'If exec_command with sandbox_permissions=require_escalated returns approval_required, do not continue or approve it yourself. Show the environment, command, requested full-access scope, and justification to the user, then wait for an explicit user reply.',
      'Only after an explicit user approval, call respond_to_escalation with decision=approve, then retry the exact same exec_command with the returned approval_id. Approval is one-shot and changing the command or execution context requires a new request.',
      'If the user denies or cancels, call respond_to_escalation with decision=deny and do not run the escalated command.',
      'Treat transient network failures carefully: a single timeout, DNS failure, connection reset, HTTP 502, or target-site 403/404/challenge does not mean a CCM environment is offline. Distinguish CCM transport, worker connectivity, command runtime, and target-site failures; verify environment health and retry transient network operations 2-3 times when appropriate.',
    ].join('\n'),
  });

  server.registerResource(
    'ccm-file-transfer',
    new ResourceTemplate('ccm-file:///{token}', { list: undefined }),
    {
      title: 'CCM transferred file',
      description: 'Temporary file transferred from a CCM environment.',
    },
    async (uri, variables) => {
      const token = String(variables.token || '');
      const entry = runtime.fileTransferStore?.get(token);
      if (!entry) {
        throw new Error('CCM file resource is unknown or expired: ' + uri);
      }
      return {
        contents: [{
          uri: entry.uri,
          mimeType: entry.mime_type,
          blob: entry.data,
          _meta: {
            filename: entry.filename,
            byte_length: entry.byte_length,
            sha256: entry.sha256,
            source_environment_id: entry.environment_id,
          },
        }],
      };
    },
  );

  for (const [name, uri] of [
    ['ccm-exec-image-bridge-ui', EXEC_IMAGE_BRIDGE_UI_URI],
    ['ccm-view-image-ui', VIEW_IMAGE_UI_URI],
    ['ccm-view-image-ui-v6', VIEW_IMAGE_V6_UI_URI],
    ['ccm-view-image-ui-v5', VIEW_IMAGE_V5_UI_URI],
    ['ccm-view-image-ui-v4', VIEW_IMAGE_V4_UI_URI],
    ['ccm-view-image-ui-v3', VIEW_IMAGE_V3_UI_URI],
    ['ccm-view-image-ui-v2', VIEW_IMAGE_V2_UI_URI],
    ['ccm-view-image-ui-v1', VIEW_IMAGE_LEGACY_UI_URI],
  ]) {
    server.registerResource(
      name,
      uri,
      {
        title: 'CCM image preview',
        description: 'Renders view_image output and forwards the image into model context when the host supports MCP Apps image context.',
        mimeType: 'text/html;profile=mcp-app',
      },
      async () => ({
        contents: [{
          uri,
          mimeType: 'text/html;profile=mcp-app',
          text: VIEW_IMAGE_UI_HTML,
          _meta: { ui: { prefersBorder: false } },
        }],
      }),
    );
  }

  for (const tool of toolRegistry.listDirect()) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(tool.mcpMeta ? { _meta: tool.mcpMeta } : {}),
    }, async (args, extra) => guardMcpToolResult(
        await tool.handler(args, { extra }),
        maxToolResultBytes,
        maxFileResultBytes,
      ));
  }
  return server;
}

export function createHttpController({
  toolRegistry,
  runtime,
  healthProvider = null,
  port = Number(process.env.CCM_PORT || 18209),
  host = process.env.CCM_HOST || '127.0.0.1',
  mcpPath = process.env.CCM_MCP_PATH || '/ccm/mcp',
  maxToolResultBytes = resolveMaxMcpToolResultBytes(
    process.env.CCM_MAX_MCP_TOOL_RESULT_BYTES,
  ),
  maxFileResultBytes = resolveMaxMcpFileResultBytes(
    process.env.CCM_MAX_MCP_FILE_RESULT_BYTES,
  ),
} = {}) {
  const app = createMcpExpressApp();
  const transports = new Map();
  const protocolServers = new Map();

  app.get('/ccm/health', (_req, res) => {
    const extraHealth = typeof healthProvider === 'function'
      ? healthProvider()
      : {};
    res.json({
      status: extraHealth.status || 'ok',
      service: 'ccm',
      default_environment_id: runtime.environmentRegistry.defaultEnvironmentId,
      environments: runtime.environmentRegistry.listPublic(),
      ...extraHealth,
    });
  });

  app.post(mcpPath, async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport = sessionId ? transports.get(sessionId) : null;

      if (!transport) {
        if (sessionId || !isInitializeRequest(req.body)) {
          res.status(400).json({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'Missing or invalid MCP session.' },
          });
          return;
        }
        const protocolServer = createProtocolServer(
          toolRegistry,
          runtime,
          maxToolResultBytes,
          maxFileResultBytes,
        );
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            transports.set(newSessionId, transport);
            protocolServers.set(newSessionId, protocolServer);
          },
        });
        transport.onclose = async () => {
          const id = transport.sessionId;
          if (!id) return;
          transports.delete(id);
          const ownedServer = protocolServers.get(id);
          protocolServers.delete(id);
          if (ownedServer) await ownedServer.close().catch(() => {});
        };
        await protocolServer.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: String(error?.message || error) },
        });
      }
    }
  });

  app.get(mcpPath, async (req, res) => {
    const transport = transports.get(req.headers['mcp-session-id']);
    if (!transport) {
      res.status(400).send('Invalid or missing MCP session.');
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete(mcpPath, async (req, res) => {
    const transport = transports.get(req.headers['mcp-session-id']);
    if (!transport) {
      res.status(400).send('Invalid or missing MCP session.');
      return;
    }
    await transport.handleRequest(req, res);
  });

  let httpServer = null;
  return {
    get address() {
      return httpServer?.address() || null;
    },
    async start() {
      if (httpServer) return httpServer;
      await new Promise((resolve, reject) => {
        httpServer = app.listen(port, host, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      return httpServer;
    },
    async close() {
      await runtime.close();
      for (const transport of transports.values()) {
        await transport.close().catch(() => {});
      }
      transports.clear();
      protocolServers.clear();
      if (!httpServer) return;
      const server = httpServer;
      httpServer = null;
      await new Promise((resolve) => server.close(() => resolve()));
    },
    get endpoint() {
      const address = httpServer?.address();
      const actualPort = typeof address === 'object' && address
        ? address.port
        : port;
      return `http://${host}:${actualPort}${mcpPath}`;
    },
  };
}
