import { randomUUID } from 'node:crypto';
import {
  PUBLISHED_FILE_UI_HTML,
  PUBLISHED_FILE_UI_URI,
} from '../ui/published-file-app.mjs';
import { publishedPreviewKind, ISOLATED_MARKUP_CSP } from './published-file-preview.mjs';
import { FILE_TOKEN_RE } from './file-transfer-store.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { CCM_ICON_PATH, CCM_ICON_ROUTE, readCcmIcon } from '../server-icon.mjs';
import {
  guardMcpToolResult,
  resolveMaxMcpFileResultBytes,
  resolveMaxMcpToolResultBytes,
} from './response-guard.mjs';
import {
  APPROVAL_UI_HTML,
  APPROVAL_UI_URI,
  LEGACY_APPROVAL_UI_URI,
  PREVIOUS_APPROVAL_UI_URI,
} from '../ui/approval-app.mjs';
import {
  WORKSPACE_HANDLE_UI_HTML,
  WORKSPACE_HANDLE_UI_URI,
} from '../ui/workspace-handle-app.mjs';

function createProtocolServer(
  toolRegistry,
  runtime,
  maxToolResultBytes,
  maxFileResultBytes,
  iconPath,
) {
  const icon = readCcmIcon(iconPath);
  const origin = icon && typeof runtime.fileDownloadOrigin === 'function'
    ? runtime.fileDownloadOrigin() : null;
  const serverInfo = {
    name: 'ccm',
    title: 'CCM',
    version: '0.1.0',
    ...(origin ? { icons: [{
      src: new URL(CCM_ICON_ROUTE, origin).href,
      mimeType: 'image/png',
      sizes: ['512x512'],
    }] } : {}),
  };
  const server = new McpServer(serverInfo, {
    capabilities: { tools: { listChanged: true } },
    instructions: [
      'CCM is a Codex-compatible execution harness.',
      'Always reuse an existing workspace_handle for the target workspace; it is not an environment_id, workspace_id, or conversation context. Call select_workspace only if no usable handle exists AND the user explicitly requests workspace entry. Call register_workspace only if the user explicitly requests workspace registration and no usable handle exists for that project. Reading, inspecting, searching, editing, or working on a project (including saying "read the workspace") does not authorize entry or registration. Never initiate workspace-entry approval implicitly.',
      'Use exec_command for ordinary shell/repository work. When a live process only needs polling and no stdin bytes are being written, invoke ccm.write_stdin through exec from the first poll, reusing the exact workspace_handle and session_id returned by exec_command. CCM rejects top-level Direct empty write_stdin polls before they reach the process session or Worker; keep the top-level Direct write_stdin path only for real non-empty interactive/TTY stdin writes. If an empty nested poll is blocked by a Host/tool-call failure before CCM returns a structured result, retry the same exec -> ccm.write_stdin route at most twice; do not fall back to Direct empty polling or create a replacement session.',
      'Use tool_search to discover list_projects, then invoke it through exec to inspect connected environments and registered projects. Omit environment_id to inspect every connected environment; pass all=true only when existing projectless workspaces also need to be listed.',
      'Use tool_search to discover deferred capabilities without expanding the top-level MCP schema.',
      'To deregister one registered project, discover deferred ccm.unregister_workspace and invoke it through exec with environment_id and workspace_id. It always returns a frozen one-shot approval request, including on full-access Workers: present request_approval with its approval_id and never bypass it. Successful approval revokes previous workspace handles, but never deletes project directories/files or forcibly stops existing OS processes.',
      'When the user explicitly asks to plan, discuss before implementation, or re-plan and a durable multi-turn Plan is useful, discover ccm.plan_patch / ccm.plan_read through tool_search. Use Codex-style planning discipline: explore discoverable facts first and do not ask for facts that reasonable non-mutating inspection can answer; if a high-impact ambiguity instead depends on a non-discoverable user preference, product/scope/compatibility choice, or meaningful tradeoff, ask rather than guess. When asking such a decision question, explicitly show 2-4 mutually exclusive choices in the user-visible question and identify a recommended default there when useful; the user may still provide another answer. Continue until the Plan is decision-complete for another executor, including implementation, interface/data-flow, failure-mode, validation, migration/cleanup, and acceptance details. While planning, ordinary read-only inspection and tests/builds limited to ignored/cache/temp side effects are allowed, but tracked implementation edits, migrations, rewriting codegen/formatting, dependency/config changes, deploy/release, commit, and push remain gated on explicit execution/implementation authorization. Keep the Plan current by removing or rewriting stale, completed, invalidated, or superseded content. When planning reaches a decision-complete stopping point and you are about to tell the user the Plan is complete or await execution authorization, read the current persisted Plan and include its complete latest text in that same user-visible reply; do not replace it with a summary, excerpt, plan_id, or change list. If plan_read is truncated and returns next_start_line, continue ordered range reads until the complete Plan has been collected before replying. This final-Plan handoff applies only when finishing the planning phase; later plan_read calls used during implementation remain lifecycle-neutral and do not require repeating the Plan or re-entering planning. Imperative task wording, Plan updates, completed inspection, workspace approval, registration approval, or sandbox escalation approval is not execution authorization. CCM does not maintain a Plan-Mode state machine or Codex Host proposal/input UI. Once the user explicitly asks to execute/implement, continue implementation; plan_read is a neutral reference lookup and never switches the workflow back to planning.',
      'If no workspace_handle is available, do not infer permission to enter or register a named project. For projectless tasks or absolute-path reads allowed by sandbox_read_scope, discover ccm.create_projectless_handle via tool_search and exec. For registered-project writes, ask for a handle or an explicit entry request. Never use projectless to bypass a pending explicitly requested workspace approval. Pass environment_id when a particular Worker is required; otherwise use the primary Worker.',
      'An environment has no GPT-visible default workspace or project directory. Do not infer project location from Worker bootstrap cwd, CCM_WORKSPACE, Documents, Temp, a drive root, or any other internal path. CCM does not define a Projects Root; new-project placement comes from the user or upper-layer orchestrator.',
      'Use direct apply_patch and view_image for model-side workspace work. ccm-extra.import_chatgpt_file remains deferred: discover it through tool_search and dispatch through exec with top-level exec.file binding; Library attachments must be materialized as raw_file before binding. It imports one file into the selected Worker context. Publish user-facing deliverables and useful previews using the direct publish_worker_file tool, one file per call; call it proactively when the user asked to create or see PPT/PDF/images/reports, without waiting for a separate send request, including stage previews when useful. Continue work after publishing when needed. publish_worker_file returns temporary CCM HTTPS links, not native ChatGPT attachments. Its card shows supported raster images or bounded UTF-8 text directly, and provides browser previews for PDF, audio, video and isolated HTML/SVG; Office formats remain download-only without conversion. Every card retains a download link. The structured download_url remains available for clients without MCP Apps. view_image only serves model-side analysis. Avoid publishing unnecessary intermediate files.',
      'Discover chatgpt_share_export through tool_search and invoke it through exec when the user supplies a public ChatGPT Share URL and wants that conversation inspected or exported; do not route that workflow through BMG/browser automation. Codex 公开共享链接 https://chatgpt.com/s/cx_... 同样通过该工具读取和导出。Discover quark_upload through tool_search and invoke it through exec when the user asks to upload known local files through the logged-in Quark Cloud Drive desktop client.',
      'For bulk image inspection, view_image is also available through exec; batch independent image calls with parallel=true when useful.',
      'Use exec/wait for structured nested capability dispatch; host Code Mode remains responsible for JavaScript/control flow.',
      'For multi-step CCM work, prefer exec for deferred/Code Mode capabilities. Only for explicitly requested workspace entry/registration: after full-access select/register success, call the Direct show_workspace_handle tool with the returned handle to display the copyable card; when approval_required=true, call the top-level request_approval tool and use its completed card for the handle. Select/register do not attach a UI, avoiding an empty card while approval is pending. Never show handles for pending/failed/projectless operations, repeat the handle in prose, or bypass a pending approval with projectless execution. Use parallel=true only for independent calls.',
      'Commands run under the selected environment permission profile. list_projects exposes independent sandbox_read_scope and sandbox_write_scope values for each connected environment. full-access means CCM does not request user approval for workspace lifecycle or execution actions and runs commands with normal Worker host permissions; workspace_handle, Worker routing, cwd/session ownership, workspace identity, and individual tool path contracts still apply. For restricted profiles, filesystem read scope comes from sandbox_read_scope, while sandbox_write_scope=context_root limits ordinary writes to the active context root unless an explicit escalation flow authorizes otherwise. Do not infer workspace selection or escalation solely from the location of a readable path. Individual file tools may impose narrower path contracts than exec_command.',
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
  // Old conversations may retain the original URI. Serve one implementation,
  // not two diverging approval code paths.
  server.registerResource(
    'ccm-approval-legacy-ui',
    LEGACY_APPROVAL_UI_URI,
    { title: 'CCM approval (legacy URI)', mimeType: 'text/html;profile=mcp-app' },
    async () => ({
      contents: [{
        uri: LEGACY_APPROVAL_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: APPROVAL_UI_HTML,
      }],
    }),
  );

  server.registerResource(
    'ccm-approval-v2-ui',
    PREVIOUS_APPROVAL_UI_URI,
    { title: 'CCM approval (previous URI)', mimeType: 'text/html;profile=mcp-app' },
    async () => ({
      contents: [{
        uri: PREVIOUS_APPROVAL_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: APPROVAL_UI_HTML,
      }],
    }),
  );

  server.registerResource(
    'ccm-published-file-ui',
    PUBLISHED_FILE_UI_URI,
    {
      title: 'CCM published file',
      mimeType: 'text/html;profile=mcp-app',
    },
    async () => ({
      contents: [{
        uri: PUBLISHED_FILE_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: PUBLISHED_FILE_UI_HTML,
        _meta: {
          'openai/widgetCSP': {
            redirect_domains: typeof runtime.fileDownloadOrigin === 'function'
              ? [runtime.fileDownloadOrigin()] : [],
          },
          ui: {
            prefersBorder: true,
            csp: {
              resourceDomains: typeof runtime.fileDownloadOrigin === 'function'
                ? [runtime.fileDownloadOrigin()] : [],
            },
          },
        },
      }],
    }),
  );

  server.registerResource(
    'ccm-workspace-handle-ui',
    WORKSPACE_HANDLE_UI_URI,
    {
      title: 'CCM workspace handle',
      mimeType: 'text/html;profile=mcp-app',
    },
    async () => ({
      contents: [{
        uri: WORKSPACE_HANDLE_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: WORKSPACE_HANDLE_UI_HTML,
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

function resolvePublishRange(header, size) {
  if (header === undefined) return null;
  const parts = typeof header === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(header) : null;
  if (!parts || (!parts[1] && !parts[2]) || size === 0) return false;
  const first = parts[1] ? Number(parts[1]) : null;
  const last = parts[2] ? Number(parts[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) ||
      (last !== null && !Number.isSafeInteger(last))) return false;
  const start = first === null ? Math.max(0, size - last) : first;
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  return start < size && end >= start && (first !== null || last > 0)
    ? { start, end } : false;
}

export function createHttpController({
  toolRegistry,
  runtime,
  iconPath = CCM_ICON_PATH,
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
  // Mcp-Session-Id is not a host conversation id, workspace_handle, process
  // session_id, approval_id, or durable plan/task identity. Do not persist
  // higher-level intent solely against this transport-scoped identifier.
  const transports = new Map();
  const protocolServers = new Map();

  const download = (req, res) => {
    const match = /^\/ccm\/(download|preview)\/([^/]+)$/.exec(req.path);
    if (!match || !FILE_TOKEN_RE.test(match[2])) {
      res.status(404).end();
      return;
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).end();
      return;
    }
    const entryInfo = runtime.fileTransferStore?.get(match[2]);
    if (!entryInfo) { res.status(404).end(); return; }
    const preview = match[1] === 'preview';
    const kind = preview ? publishedPreviewKind(entryInfo.mime_type) : null;
    if (preview && !kind) { res.status(404).end(); return; }
    const range = resolvePublishRange(req.headers.range, entryInfo.byte_length);
    if (range === false) {
      res.setHeader('Content-Range', `bytes */${entryInfo.byte_length}`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(416).end();
      return;
    }
    const acquired = runtime.fileTransferStore?.acquire(match[2], range || null);
    if (!acquired) { res.status(404).end(); return; }
    const { entry, stream, release } = acquired;
    const textView = kind === 'text';
    const safeFilename = entry.filename.replace(/[\r\n\\/"\x00-\x1f\x7f]/g, '_');
    const asciiName = safeFilename.replace(/[^\x20-\x7e]/g, '_').replace(/[%\\]/g, '_');
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(entry.mime_type) ? entry.mime_type : 'application/octet-stream';
    res.status(range ? 206 : 200);
    res.setHeader('Content-Length', range ? range.end - range.start + 1 : entry.byte_length);
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${entry.byte_length}`);
    res.setHeader('Content-Type', textView ? 'text/plain; charset=utf-8' : preview ? entry.mime_type : mime);
    res.setHeader('Content-Disposition', preview ? 'inline' : 'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(safeFilename));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (kind === 'markup') res.setHeader('Content-Security-Policy', ISOLATED_MARKUP_CSP);
    stream.on('close', release);
    stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };
  app.all(/^\/ccm\/(?:download|preview)(?:\/.*)?$/, download);

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
          iconPath,
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
