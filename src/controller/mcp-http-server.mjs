import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constantTimeEqual } from '../../ccm-sidecar/oauth.mjs';
import { readCcmSection } from '../runtime/ccm-config.mjs';
import {
  PUBLISHED_FILE_UI_HTML,
  PUBLISHED_FILE_UI_URI,
} from '../ui/published-file-app.mjs';
import { publishedPreviewKind, ISOLATED_MARKUP_CSP } from './published-file-preview.mjs';
import { renderMarkdownDocument } from './markdown-preview.mjs';
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
  VERIFICATION_INPUT_UI_HTML,
  VERIFICATION_INPUT_UI_URI,
} from '../ui/verification-input-app.mjs';

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
      'Always reuse an existing workspace_handle for the target workspace; it is not an environment_id, workspace_id, or conversation context. Call select_workspace or register_workspace directly only when no usable handle exists and the user explicitly requests workspace entry or registration. Reading, inspecting, editing, or working on a project does not authorize entry or registration. Never initiate workspace-entry approval implicitly.',
      'Use exec_command for ordinary shell and repository work. Poll live process sessions directly with write_stdin, reusing the exact workspace_handle and session_id; an empty chars value is a read-only poll. On a Host failure without a structured CCM result, do not assume the session was polled or create a replacement session.',
      'When a live CCM process requests a verification code, show request_verification_input with its workspace_handle and session_id. The user submits the code through the App card, which automatically sends a code-free follow-up. Do not inspect the code or check whether it was entered/submitted. Wait for that follow-up, then assume the code was submitted and continue the original task normally. Host filtering can block code/status probing. Only if normal task execution reports invalid verification should you show another card for a live session; never request the code in chat or commands.',
      'Owner-issued timed CCM Full Access uses the separate /ccm/unlock browser page: the owner pairs a browser once using a phone TOTP code, chooses a duration and clicks unlock. This creates a pending grant. The browser copy button first writes the ID to the clipboard and then claims it through the authenticated Controller bridge; on success the webpage returns to its locked/unlock-form state. Only claimed IDs are valid; copying text manually without the claim does not activate the ID. If the owner provides the copied ID after webpage confirmation, use it directly on exec_command, apply_patch or explicitly requested select_workspace/register_workspace calls without calling claim_full_access. If the owner reports unlocking but provides no ID, call claim_full_access directly: this claims the pending grant, or, if the browser already claimed it but the message was blocked, retrieves that same ID once within the original five-minute claim window. The grant expires at the deadline counted from web unlock and recovery never extends it. Claimed grants remain usable when the webpage returns to locked state and when a new pending grant is issued. Never guess an ID, expose phone seed/TOTP to the model, or infer authority from absent IDs. Repeated web clicks while pending do not replace/extend it. Expiry blocks new Full Access operations but does not kill running processes. Unregister always requires its own approval.',
      'Call list_projects directly to inspect connected environments and registered projects. Omit environment_id to inspect every connected environment; pass all=true only when existing projectless workspaces also need to be listed.',
      'All model-facing CCM capabilities are listed as ordinary peer tools by MCP tools/list. The Host owns tool discovery and invocation selection; CCM does not provide a nested discovery or dispatch layer.',
      'To deregister one registered project, call unregister_workspace directly with environment_id and workspace_id. It always returns a frozen one-shot approval request, including on full-access Workers: present request_approval with its approval_id and never bypass it. Successful approval revokes previous workspace handles without deleting project files or forcibly stopping existing processes.',
      'When the user explicitly asks to plan, discuss before implementation, or re-plan and a durable multi-turn Plan is useful, call plan_patch / plan_read directly. Use Codex-style planning discipline: explore discoverable facts first and do not ask for facts that reasonable non-mutating inspection can answer; if a high-impact ambiguity instead depends on a non-discoverable user preference, product/scope/compatibility choice, or meaningful tradeoff, ask rather than guess. When asking such a decision question, explicitly show 2-4 mutually exclusive choices in the user-visible question and identify a recommended default there when useful; the user may still provide another answer. Continue until the Plan is decision-complete for another executor, including implementation, interface/data-flow, failure-mode, validation, migration/cleanup, and acceptance details. While planning, ordinary read-only inspection and tests/builds limited to ignored/cache/temp side effects are allowed, but tracked implementation edits, migrations, rewriting codegen/formatting, dependency/config changes, deploy/release, commit, and push remain gated on explicit execution/implementation authorization. Keep the Plan current by removing or rewriting stale, completed, invalidated, or superseded content. When planning reaches a decision-complete stopping point or awaits execution authorization, call ccm-extra.publish with plan_id alone to publish an immutable snapshot of the entire latest Plan. Do not read the entire Plan solely for the handoff or copy its full text into chat; give a concise summary and refer to the published file card/link. If publishing fails, report it clearly without claiming success or automatically dumping the full Plan. Publishing does not grant execution authorization. This handoff applies only to completing planning; later plan_read calls during implementation remain lifecycle-neutral and do not trigger republishing or re-enter planning. Imperative task wording, Plan updates, completed inspection, workspace approval, registration approval, or sandbox escalation approval is not execution authorization. CCM does not maintain a Plan-Mode state machine or Codex Host proposal/input UI. Once the user explicitly asks to execute/implement, continue implementation; plan_read is a neutral reference lookup and never switches the workflow back to planning.',
      'If no workspace_handle is available, do not infer permission to enter or register a named project. For genuinely projectless tasks or absolute-path reads allowed by sandbox_read_scope, call create_projectless_handle. For registered-project writes, ask for a handle or an explicit entry request. Never use projectless to bypass a pending explicitly requested workspace approval. Pass environment_id when a particular Worker is required; otherwise use the primary Worker.',
      'An environment has no GPT-visible default workspace or project directory. Do not infer project location from Worker bootstrap cwd, CCM_WORKSPACE, Documents, Temp, a drive root, or any other internal path. CCM does not define a Projects Root; new-project placement comes from the user or upper-layer orchestrator.',
      'Use apply_patch and view_image for model-side workspace work. ccm-extra.publish accepts either plan_id alone for Controller Plans or workspace_handle plus path for Worker files, never both modes together. ccm-extra.import_chatgpt_file is a peer tool with direct native file binding; Library attachments must be materialized as raw_file before binding. It imports one file into the selected Worker context. Publish user-facing deliverables and useful previews using the direct publish tool, one file per call; call it proactively when the user asked to create or see PPT/PDF/images/reports, without waiting for a separate send request, including stage previews when useful. Continue work after publishing when needed. publish returns temporary CCM HTTPS links, not native ChatGPT attachments. For Markdown including Plans, the card shows a bounded rendered excerpt and the full preview link opens an isolated formatted HTML page; the original Markdown remains downloadable. Markdown publish also returns browser-rendered screenshot images and formula/layout diagnostics directly to the model in that same tool result. Inspect the screenshots before claiming visual verification; if unavailable, explicitly report it. Fix detected visual errors and publish the corrected file again; representative screenshots of long documents are not exhaustive. Other UTF-8 text shows source excerpts, raster images display inline, and PDF/audio/video/HTML/SVG offer browser previews; Office formats remain download-only without conversion. Every card retains a download link. The structured download_url remains available for clients without MCP Apps. view_image only serves model-side analysis. Avoid publishing unnecessary intermediate files.',
      'For shared conversations at https://chatgpt.com/share/... or https://chatgpt.com/s/cx_..., call ccm-extra.conversation directly: first action=import, then thread/read, thread/turns/list, thread/items/list, or export with the conversation_id returned by import. For local Codex thread UUIDs use the same tool with thread_id and the owning environment_id. Do not use web search, web browsing, BMG, or browser automation to retrieve shared-conversation content; report CCM retrieval failures without silently switching methods.',
      'Call quark_upload directly to upload known local files through the logged-in Quark Cloud Drive desktop client.',
      'For bulk image inspection, the Host can invoke view_image independently for each image.',
      'Use the Host orchestration layer for multi-step workflows, control flow and parallel calls.',
      'For workspace entry or registration, call select_workspace or register_workspace only with explicit user authorization and no usable handle. After full-access success, use the returned workspace_handle directly; the user can copy it from the tool result. When approval_required=true, call request_approval and use its completed card for the handle. Select/register do not attach a UI while approval is pending. Never show handles for pending/failed/projectless operations or bypass a pending approval.',
      'Commands run under the selected environment permission profile. list_projects exposes independent sandbox_read_scope and sandbox_write_scope values for each connected environment. full-access means CCM does not request user approval for workspace lifecycle or execution actions and runs commands with normal Worker host permissions; workspace_handle, Worker routing, cwd/session ownership, workspace identity, and individual tool path contracts still apply. For restricted profiles, filesystem read scope comes from sandbox_read_scope, while sandbox_write_scope=context_root limits ordinary writes to the active context root unless an explicit escalation flow authorizes otherwise. Do not infer workspace selection or escalation solely from the location of a readable path. Individual file tools may impose narrower path contracts than exec_command.',
      'On Windows, exec_command(run_as_admin=true) requests one-time Guardian or human approval before dispatch to the separately installed elevated local administrator agent. No saved command Allow rule, Full Access grant or ordinary escalation authorizes administrator execution. Normal Worker processes stay unelevated. Administrator commands have unrestricted privileges without a workspace-write boundary; request them only when needed. A missing agent fails closed.',
      'CCM error semantics: distinguish CCM results from host/tool-call failures. A normal CCM exec_command result contains CCM fields such as chunk_id, wall_time_seconds, output, exit_code/session_id, or approval_required. If the host returns a Script error or other failure without a CCM structured result, do not attribute it to CCM: the command may not have been dispatched to the CCM worker.',
      'CCM itself does not perform or report GPT/OpenAI safety review. Do not describe host-side safety/policy/tool-call errors as CCM refusals. Only describe a refusal as CCM-originated when CCM returns an explicit CCM error/result that says so.',
      'Runtime, shell, path, non-zero exit, timeout, network, HTTP, DNS, proxy, and target-site errors are execution/target failures, not CCM safety refusals. Verify the relevant layer before assigning a cause.',
      'The Controller evaluates statically parsed executable segments using native Codex ExecPolicy .rules. Allow grants Full Access, Prompt requires approval, Forbidden rejects, and ambiguous syntax cannot inherit Allow. When a workspace-write command needs Full Access without a matching Allow, call exec_command with sandbox_permissions=require_escalated and optional prefix_rule. Approved Always allow prefixes are saved in the same native Codex policy and apply across Workers and workspaces.',
      'For a requested escalation, native Prompt, or run_as_admin request, provide exec_command.review_context with an accurate task/authorization/constraint summary from the main model. When enabled, the CPA codex-auto-review Guardian first evaluates the frozen one-time action including its administrator execution mode using the same model-visible CCM tool permissions; its allow dispatches once, deny refuses, and any review failure falls back to the existing human approval card. Guardian decisions never create persistent Always allow rules; administrator approvals never allow persistent rules either. Do not report a failed or skipped review as approved.',
      'When requesting Full Access for a build, test, development tool, or other command likely to be repeated, proactively provide a useful prefix_rule: include stable executable, subcommand, script path and fixed arguments; omit frequently changing suffix arguments. Example: npm run build:native -> prefix_rule=["npm","run","build:native"]. Do not propose a generic shell or interpreter alone (powershell, pwsh, cmd, node); choose a narrowly useful prefix. Always allow creates a global cross-Worker/cross-workspace rule, and the approval card displays the exact prefix so the owner can decide whether to save it. Supply prefix_rule only with require_escalated, never on ordinary sandboxed execution.',
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
    'ccm-verification-input-ui',
    VERIFICATION_INPUT_UI_URI,
    {
      title: 'CCM verification input',
      description: 'User-entered verification input delivered to a live CCM session.',
      mimeType: 'text/html;profile=mcp-app',
    },
    async () => ({
      contents: [{
        uri: VERIFICATION_INPUT_UI_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: VERIFICATION_INPUT_UI_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    }),
  );

  for (const tool of toolRegistry.list()) {
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
  unlockBridgeSecret = null,
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
  // The sidecar and Controller are independent local processes. The bridge is
  // loopback-only and authenticated with their existing ignored OAuth secret.
  // This route is deliberately not exposed by the Funnel allowlist.
  const resolveBridgeSecret = () => {
    if (unlockBridgeSecret != null) return unlockBridgeSecret;
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const vars = readCcmSection('controller', path.join(root, 'ccm.config.json')).env;
    return vars.CCM_APPROVAL_SECRET ||
      fs.readFileSync(path.resolve(root, vars.CCM_APPROVAL_SECRET_FILE ||
        '.state/ccm-approval-secret.txt'), 'utf8').trim();
  };
  app.post('/ccm/internal/web-unlock', (req, res) => {
    const remote = req.socket.remoteAddress;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    try {
      const provided = req.headers['x-ccm-unlock-bridge'];
      if (typeof provided !== 'string' ||
          !constantTimeEqual(provided, resolveBridgeSecret())) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      if (req.body?.action === 'status') {
        res.json(runtime.webFullAccess.status());
      } else if (req.body?.action === 'issue') {
        res.json(runtime.webFullAccess.issue(req.body.duration_seconds));
      } else if (req.body?.action === 'claim') {
        if (typeof req.body.grant_id !== 'string' ||
            !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.body.grant_id)) {
          res.status(400).json({ error: 'invalid_grant_id' });
        } else {
          const claim = runtime.webFullAccess.claim(req.body.grant_id);
          if (!claim) res.status(409).json({ error: 'grant_unavailable' });
          else res.json(claim);
        }
      } else {
        res.status(400).json({ error: 'invalid_action' });
      }
    } catch {
      res.status(503).json({ error: 'unlock_unavailable' });
    }
  });
  // These maps are keyed by the MCP Streamable HTTP protocol/transport session.
  // Mcp-Session-Id is not a host conversation id, workspace_handle, process
  // session_id, approval_id, or durable plan/task identity. Do not persist
  // higher-level intent solely against this transport-scoped identifier.
  const transports = new Map();
  const protocolServers = new Map();

  const download = async (req, res) => {
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
    if (kind === 'markdown') {
      const acquired = runtime.fileTransferStore?.acquire(match[2]);
      if (!acquired) { res.status(404).end(); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', ISOLATED_MARKUP_CSP);
      try {
        const parts = [];
        for await (const chunk of acquired.stream) parts.push(chunk);
        const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
        if (source.includes('\0')) throw new Error('Invalid Markdown content');
        res.status(200).type('html').send(renderMarkdownDocument(source, acquired.entry.filename));
      } catch {
        if (!res.headersSent) {
          res.status(422).type('text/plain').send('Markdown preview unavailable. Download the original file.');
        } else res.destroy();
      } finally {
        acquired.release();
      }
      return;
    }
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
