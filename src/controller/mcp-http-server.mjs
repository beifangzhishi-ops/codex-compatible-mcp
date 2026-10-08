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
      'Use exec_command for ordinary shell/repository work. When a live process only needs polling and no stdin bytes are being written, invoke ccm.write_stdin through exec from the first poll, reusing the exact workspace_context and session_id returned by exec_command. CCM rejects top-level Direct empty write_stdin polls before they reach the process session or Worker; keep the top-level Direct write_stdin path only for real non-empty interactive/TTY stdin writes. If an empty nested poll is blocked by a Host/tool-call failure before CCM returns a structured result, retry the same exec -> ccm.write_stdin route at most twice; do not fall back to Direct empty polling or create a replacement session.',
      'Use tool_search to discover list_projects, then invoke it through exec to inspect connected environments and registered projects. Omit environment_id to inspect every connected environment; pass all=true only when existing projectless contexts also need to be listed.',
      'Use tool_search to discover deferred capabilities without expanding the top-level MCP schema.',
      'When the user explicitly asks to plan, discuss before implementation, or re-plan and a durable multi-turn Plan is useful, discover ccm.plan_patch / ccm.plan_read through tool_search. Use Codex-style planning discipline: explore discoverable facts first and do not ask for facts that reasonable non-mutating inspection can answer; if a high-impact ambiguity instead depends on a non-discoverable user preference, product/scope/compatibility choice, or meaningful tradeoff, ask rather than guess. When asking such a decision question, explicitly show 2-4 mutually exclusive choices in the user-visible question and identify a recommended default there when useful; the user may still provide another answer. Continue until the Plan is decision-complete for another executor, including implementation, interface/data-flow, failure-mode, validation, migration/cleanup, and acceptance details. While planning, ordinary read-only inspection and tests/builds limited to ignored/cache/temp side effects are allowed, but tracked implementation edits, migrations, rewriting codegen/formatting, dependency/config changes, deploy/release, commit, and push remain gated on explicit execution/implementation authorization. Keep the Plan current by removing or rewriting stale, completed, invalidated, or superseded content. When planning reaches a decision-complete stopping point and you are about to tell the user the Plan is complete or await execution authorization, read the current persisted Plan and include its complete latest text in that same user-visible reply; do not replace it with a summary, excerpt, plan_id, or change list. If plan_read is truncated and returns next_start_line, continue ordered range reads until the complete Plan has been collected before replying. This final-Plan handoff applies only when finishing the planning phase; later plan_read calls used during implementation remain lifecycle-neutral and do not require repeating the Plan or re-entering planning. Imperative task wording, Plan updates, completed inspection, workspace approval, registration approval, or sandbox escalation approval is not execution authorization. CCM does not maintain a Plan-Mode state machine or Codex Host proposal/input UI. Once the user explicitly asks to execute/implement, continue implementation; plan_read is a neutral reference lookup and never switches the workflow back to planning.',
      'If an operational tool requires workspace_context and the user has not selected, requested, or otherwise indicated a real registered project, discover ccm.create_projectless_context with tool_search and invoke it through exec. Do not use projectless as a fallback to bypass select_workspace or register_workspace while that pending action still targets the user\'s current intended real project. If the user explicitly changes to a different real project, directly select or register the new target; an older pending workspace approval does not need to be denied or resolved first. Specify environment_id when a particular Worker is required; omit it to use the primary environment. Use the returned workspace_context for subsequent CCM operations.',
      'An environment has no GPT-visible default workspace or project directory. Do not infer project location from Worker bootstrap cwd, CCM_WORKSPACE, Documents, Temp, a drive root, or any other internal path. CCM does not define a Projects Root; new-project placement comes from the user or upper-layer orchestrator.',
      'Use direct apply_patch and view_image for common workspace file operations. receive_file remains deferred: discover it through tool_search and dispatch it through exec. For an ordinary conversation attachment, bind it through top-level exec.file. For a Library file, first materialize the exact Library object as raw_file with ChatGPT Files, then bind that materialized file through exec.file. Dispatch ccm-extra.receive_file sequentially; its destination remains relative to the selected context root. send_file is an exact-discovery terminal handoff: use tool_search with exactly send_file or ccm-extra.send_file only when the user explicitly asks for a known local Worker file as a native ChatGPT attachment, and call it only after all required analysis, verification, editing, testing, and other tool work is complete. Never use send_file for inspection, verification, stage previews, or intermediate cross-tool transfer. The ChatGPT Host may require user interaction to materialize the native attachment; that is Host-owned confirmation, not CCM approval, and CCM does not bypass it. send_file requires workspace_context, is strictly single-file, and multiple files must be sent sequentially. It stores the exact Worker bytes in the persistent CCM file bridge and returns a standard MCP resource link that exec passes through for the host to present natively. Treat 1 KiB (1024 bytes) as the operational minimum for reliable ChatGPT attachment downloads: sub-1-KiB files may still be transferred exactly, but some clients can remain stuck connecting. Never pad or alter a source file to cross that threshold; warn the user instead.',
      'Discover chatgpt_share_export through tool_search and invoke it through exec when the user supplies a public ChatGPT Share URL and wants that conversation inspected or exported; do not route that workflow through BMG/browser automation. Codex 公开共享链接 https://chatgpt.com/s/cx_... 同样通过该工具读取和导出。Discover quark_upload through tool_search and invoke it through exec when the user asks to upload known local files through the logged-in Quark Cloud Drive desktop client.',
      'For bulk image inspection, view_image is also available through exec; batch independent image calls with parallel=true when useful.',
      'Use exec/wait for structured nested capability dispatch; host Code Mode remains responsible for JavaScript/control flow.',
      'For multi-step CCM work, prefer exec for deferred/Code Mode capabilities and specialized ccm-extra tools. Workspace lifecycle tools such as select_workspace/register_workspace are deferred: discover them with tool_search and invoke them through exec. Full-access environments complete those workspace actions directly; restricted environments may return approval_required=true, in which case use the top-level request_approval tool with the returned approval_id. While that workspace remains the user\'s intended target, wait for the frozen action and do not use projectless context to continue that project task. If the user explicitly corrects or changes the target to a different real project, directly call select_workspace or register_workspace for the new target without requiring the older pending approval to be denied or resolved first; independent pending workspace approvals may coexist. Direct operational tools may also support nested exec calls when their surface allows it. Use parallel=true only for independent calls.',
      'Commands run under the selected environment permission profile. list_projects exposes independent sandbox_read_scope and sandbox_write_scope values for each connected environment. full-access means CCM does not request user approval for workspace lifecycle or execution actions and runs commands with normal Worker host permissions; workspace_context, Worker routing, cwd/session ownership, workspace identity, and individual tool path contracts still apply. For restricted profiles, filesystem read scope comes from sandbox_read_scope, while sandbox_write_scope=context_root limits ordinary writes to the active context root unless an explicit escalation flow authorizes otherwise. Do not infer workspace selection or escalation solely from the location of a readable path. Individual file tools may impose narrower path contracts than exec_command.',
      'CCM error semantics: distinguish CCM results from host/tool-call failures. A normal CCM exec_command result contains CCM fields such as chunk_id, wall_time_seconds, output, exit_code/session_id, or approval_required. If the host returns a Script error or other failure without a CCM structured result, do not attribute it to CCM: the command may not have been dispatched to the CCM worker.',
      'CCM itself does not perform or report GPT/OpenAI safety review. Do not describe host-side safety/policy/tool-call errors as CCM refusals. Only describe a refusal as CCM-originated when CCM returns an explicit CCM error/result that says so.',
      'Runtime, shell, path, non-zero exit, timeout, network, HTTP, DNS, proxy, and target-site errors are execution/target failures, not CCM safety refusals. Verify the relevant layer before assigning a cause.',
      'When a workspace-write command genuinely requires full-access, call exec_command with sandbox_permissions=require_escalated and an optional justification. You may also provide prefix_rule as ordered command tokens when proposing a reusable Always-allow scope. If no trusted rule or saved workspace prefix applies, CCM freezes the exact command plus the validated persistent scope and returns approval_required=true without executing it. Saved generic policies are token-prefix rules and can authorize later suffix arguments. On Windows, direct node --test is a built-in trusted full-access class; WSL calls blocked by the restricted token may be retried escalated, where a saved wsl.exe/distro prefix can authorize the retry.',
      'For every CCM result with approval_required=true, call the top-level request_approval tool with exactly the returned approval_id. request_approval only presents the already-frozen action in the CCM approval card; it does not accept replacement command/path/workspace parameters.',
      'The user approves or denies inside the CCM approval card. Do not call resolve_pending_action yourself and do not reconstruct or retry the original command/workspace tool after the card is shown. The app-only resolver resumes only the frozen pending action.',
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
    const environments = runtime.environmentRegistry.listPublic().map(
      (environment) => ({
        ...environment,
        ...(runtime.workerHub?.environmentStatus?.(environment.id) || {
          state: 'normal',
        }),
      }),
    );
    const hasAbnormalEnvironment = environments.some(
      (environment) => environment.state === 'abnormal',
    );
    const reportedStatus = extraHealth.status || 'ok';
    const status = hasAbnormalEnvironment && reportedStatus === 'ok'
      ? 'degraded'
      : reportedStatus;
    res.json({
      ...extraHealth,
      service: 'ccm',
      default_environment_id: runtime.environmentRegistry.defaultEnvironmentId,
      environments,
      status,
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
