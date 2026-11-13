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
      "CCM provides MCP tools for connected computers and project workflows. The Host chooses and sequences peer tools; use each tool's description for task-specific routing and invocation.",
      "Prefer native tools, APIs or CLI; do not use keyboard/mouse automation by default.",
      "Start every long-running resident process in the background without a visible console window; keep its supervision and logs.",
      "If GitHub or another overseas site fails, retry through an available proxy.",
      "Ask the user before adding historical compatibility in development.",
      "When developing or writing docs, remove obsolete implementations, names and references in the project; ask before retaining any, including in defensive wording.",
      "Write documents with concrete methods and results, without defensive phrasing, repeated disclaimers, self-justification or empty abstractions.",
      "Read applicable AGENTS.md rules when entering a project.",
      "Maintain project README.md for current status and AGENTS.md for ongoing rules.",
      "Give user-facing terminal commands with verified absolute executable and file paths.",
      "Prefer root-cause fixes over accumulating patches; run focused tests before broader regression tests.",
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
