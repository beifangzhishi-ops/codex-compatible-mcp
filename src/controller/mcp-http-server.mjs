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
  EXEC_IMAGE_BRIDGE_UI_HTML,
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
import {
  SEND_FILE_UI_HTML,
  SEND_FILE_UI_URI,
} from '../ui/send-file-app.mjs';
import {
  APPROVAL_UI_HTML,
  APPROVAL_UI_URI,
} from '../ui/approval-app.mjs';

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
      'Use exec_command for ordinary shell/repository work and write_stdin for live sessions. Both require the workspace_context that owns the operation; copy workspace_context together with session_id when continuing a live process.',
      'Use list_environments when environment selection is unclear.',
      'Use tool_search to discover deferred capabilities without expanding the top-level MCP schema.',
      'When the user explicitly asks to plan, discuss before implementation, or re-plan and a durable multi-turn Plan is useful, discover ccm.plan_patch / ccm.plan_read through tool_search. plan_patch carries Codex-style planning discipline: inspect discoverable facts without tracked-state mutation, resolve user intent/tradeoffs, then resolve implementation/test details until the Plan is decision-complete; keep the Plan current by removing or rewriting stale, completed, invalidated, or superseded content. Unless the user clearly and explicitly instructs execution/implementation, remain in planning. Imperative task wording, Plan updates, completed inspection, workspace approval, registration approval, or sandbox escalation approval is not execution authorization. CCM does not maintain a Plan-Mode state machine. Once the user explicitly asks to execute/implement, continue implementation; plan_read is a neutral reference lookup and never switches the workflow back to planning.',
      'If an operational tool requires workspace_context and the user did not explicitly select a project or directory, automatically discover ccm.create_projectless_context with tool_search and invoke it through exec. Specify environment_id there when a particular Worker is required; omit it to use the primary environment. Do not ask the user to choose a directory and do not register/select an arbitrary temporary directory merely to obtain context.',
      'An environment has no GPT-visible default workspace or project directory. Do not infer project location from Worker bootstrap cwd, CCM_WORKSPACE, Documents, Temp, a drive root, or any other internal path. CCM does not define a Projects Root; new-project placement comes from the user or upper-layer orchestrator.',
      'Use direct apply_patch, view_image, and send_file for common file operations. They require workspace_context. send_file is strictly single-file: one call transfers one path. If multiple files are needed, invoke send_file sequentially and wait for each call to return before starting the next; never issue concurrent or parallel send_file calls. Relative send_file paths are resolved from the selected workspace/projectless root; absolute paths remain absolute on the selected Worker.',
      'For bulk image inspection, view_image is also available through exec; batch independent image calls with parallel=true when useful.',
      'Use exec/wait for structured nested capability dispatch; host Code Mode remains responsible for JavaScript/control flow.',
      'For multi-step CCM work, prefer exec for deferred/Code Mode capabilities and specialized ccm-extra tools. select_workspace/register_workspace are direct approval-card tools and should be called directly when user approval is required; their Code Mode exposure exists only for legacy compatibility. Direct operational tools may also support nested exec calls. Use parallel=true only for independent calls.',
      'Commands run under the selected environment permission profile. list_environments exposes a coarse effective filesystem_access summary. Treat workspace boundaries and read boundaries separately: when read_scope=host, absolute-path reads outside the selected workspace should be attempted normally and must not request escalation merely because they are outside the workspace. Writes must stay within the reported write_scope unless an explicit escalation flow authorizes otherwise.',
      'CCM error semantics: distinguish CCM results from host/tool-call failures. A normal CCM exec_command result contains CCM fields such as chunk_id, wall_time_seconds, output, exit_code/session_id, or approval_required. If the host returns a Script error or other failure without a CCM structured result, do not attribute it to CCM: the command may not have been dispatched to the CCM worker.',
      'CCM itself does not perform or report GPT/OpenAI safety review. Do not describe host-side safety/policy/tool-call errors as CCM refusals. Only describe a refusal as CCM-originated when CCM returns an explicit CCM error/result that says so.',
      'Runtime, shell, path, non-zero exit, timeout, network, HTTP, DNS, proxy, and target-site errors are execution/target failures, not CCM safety refusals. Verify the relevant layer before assigning a cause.',
      'When a workspace-write command genuinely requires full-access, call the direct request_escalated_exec tool instead of exec_command(sandbox_permissions=require_escalated). request_escalated_exec freezes the exact action and renders the CCM approval card; it does not execute the command itself.',
      'The user approves or denies escalated execution inside the CCM approval card. Do not call resolve_pending_action yourself, do not call respond_to_escalation for execution approvals, and do not reconstruct or retry the command after the approval card is shown. CCM resumes only the frozen action after the card decision.',
      'Direct select_workspace/register_workspace calls freeze the exact workspace action and render the same CCM approval card. The card resolves the frozen action and returns workspace_context; do not ask for a text approval, call respond_to_escalation, or retry the workspace tool after the card is shown.',
      'Nested Code Mode select_workspace/register_workspace calls retain the old approval_id/respond_to_escalation/retry flow only for compatibility because nested tool results cannot render an MCP App.',
      'respond_to_escalation remains only for already-issued legacy approvals. New direct execution and workspace approval-card requests cannot be resolved through it.',
      'Treat transient network failures carefully: a single timeout, DNS failure, connection reset, HTTP 502, or target-site 403/404/challenge does not mean a CCM environment is offline. Distinguish CCM transport, worker connectivity, command runtime, and target-site failures; verify environment health and retry transient network operations 2-3 times when appropriate.',
    ].join('\n'),
  });

  server.registerResource(
    'ccm-exec-image-bridge-ui-legacy',
    EXEC_IMAGE_BRIDGE_UI_URI,
    {
      title: 'CCM legacy exec image bridge',
      description: 'Compatibility resource for clients that cached the former exec output template.',
      mimeType: 'text/html;profile=mcp-app',
    },
    async () => ({
      contents: [{
        uri: EXEC_IMAGE_BRIDGE_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: EXEC_IMAGE_BRIDGE_UI_HTML,
        _meta: { ui: { prefersBorder: false } },
      }],
    }),
  );

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

  server.registerResource(
    'ccm-send-file-ui',
    SEND_FILE_UI_URI,
    {
      title: 'CCM file transfer',
      description: 'Persistent ChatGPT file-transfer card.',
      mimeType: 'text/html;profile=mcp-app',
    },
    async () => ({
      contents: [{
        uri: SEND_FILE_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: SEND_FILE_UI_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    }),
  );

  server.registerResource(
    'ccm-approval-ui',
    APPROVAL_UI_URI,
    {
      title: 'CCM approval',
      description: 'User approval card for one frozen CCM execution or workspace action.',
      mimeType: 'text/html;profile=mcp-app',
    },
    async () => ({
      contents: [{
        uri: APPROVAL_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: APPROVAL_UI_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    }),
  );

  for (const [name, uri] of [
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
  // These maps are keyed by the MCP Streamable HTTP protocol/transport session.
  // Mcp-Session-Id is not a host conversation id, workspace_context, process
  // session_id, approval_id, or durable plan/task identity. Do not persist
  // higher-level intent solely against this transport-scoped identifier.
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
