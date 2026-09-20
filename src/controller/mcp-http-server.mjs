import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  guardMcpToolResult,
  resolveMaxMcpFileResultBytes,
  resolveMaxMcpToolResultBytes,
} from './response-guard.mjs';

const SERVER_INFO = { name: 'ccm', version: '0.1.0' };

function createProtocolServer(
  toolRegistry,
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
      'Commands run under the selected environment permission profile.',
      'If exec_command with sandbox_permissions=require_escalated returns approval_required, do not continue or approve it yourself. Show the environment, command, requested full-access scope, and justification to the user, then wait for an explicit user reply.',
      'Only after an explicit user approval, call respond_to_escalation with decision=approve, then retry the exact same exec_command with the returned approval_id. Approval is one-shot and changing the command or execution context requires a new request.',
      'If the user denies or cancels, call respond_to_escalation with decision=deny and do not run the escalated command.',
      'Treat transient network failures carefully: a single timeout, DNS failure, connection reset, HTTP 502, or target-site 403/404/challenge does not mean a CCM environment is offline. Distinguish CCM transport, worker connectivity, command runtime, and target-site failures; verify environment health and retry transient network operations 2-3 times when appropriate.',
    ].join('\n'),
  });

  for (const tool of toolRegistry.listDirect()) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
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
    res.json({
      status: 'ok',
      service: 'ccm',
      default_environment_id: runtime.environmentRegistry.defaultEnvironmentId,
      environments: runtime.environmentRegistry.listPublic(),
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
