import * as z from 'zod/v4';
import { PUBLISHED_FILE_UI_URI } from '../ui/published-file-app.mjs';
import { textPreviewFromBase64 } from '../controller/text-file-preview.mjs';
import { publishedPreviewKind } from '../controller/published-file-preview.mjs';
import { renderMarkdownFragment } from '../controller/markdown-preview.mjs';
import { inspectMarkdownRender } from '../controller/markdown-visual-inspection.mjs';
function toolError(error) {
  return {
    content: [{ type: 'text', text: String(error?.message || error) }],
    isError: true,
  };
}

function execResult(value, metadata = {}) {
  const structuredContent = { ...value, ...metadata };
  const lines = [];
  if (value.chunk_id) lines.push('Chunk ID: ' + value.chunk_id);
  if (Number.isFinite(value.wall_time_seconds)) {
    lines.push(
      'Wall time: ' + Number(value.wall_time_seconds).toFixed(4) + ' seconds',
    );
  }
  if (value.exit_code !== undefined) {
    lines.push('Process exited with code ' + value.exit_code);
  }
  if (value.session_id !== undefined) {
    lines.push('Process running with session ID ' + value.session_id);
  }
  lines.push('Output:');
  if (value.output) lines.push(value.output);
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent,
    ...(value.exit_code !== undefined && value.exit_code !== 0
      ? { isError: true }
      : {}),
  };
}

async function fileResourceResult(value, environmentId, runtime, metadata = {}, options = {}) {
  const fileTransferStore = runtime.fileTransferStore;
  if (!fileTransferStore) {
    throw new Error('CCM file-transfer store is unavailable.');
  }
  const origin = runtime.fileDownloadOrigin();
  if (!/^https:\/\//.test(origin)) throw new Error('Valid HTTPS file origin is required.');
  const previewKind = publishedPreviewKind(value.mime_type);
  let markdownSource;
  if (previewKind === 'markdown') {
    markdownSource = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value.data, 'base64'));
    if (markdownSource.includes('\0')) throw new Error('Markdown contains NUL bytes');
  }
  let renderCheck = null;
  if (markdownSource != null && !options.existingTransfer) {
    renderCheck = await inspectMarkdownRender(markdownSource, value.filename);
  }
  const transfer = options.existingTransfer || fileTransferStore.put(value, { environmentId });
  const url = origin + '/ccm/download/' + transfer.token;
  const previewUrl = previewKind && previewKind !== 'text'
    ? origin + '/ccm/preview/' + transfer.token : undefined;
  const textPreview = (previewKind === 'text' || previewKind === 'markdown')
    ? textPreviewFromBase64(value.data, transfer.mime_type) : null;
  const textUrl = previewKind === 'text' && textPreview
    ? origin + '/ccm/preview/' + transfer.token : undefined;
  const candidateMarkdown = previewKind === 'markdown' && textPreview
    ? renderMarkdownFragment(textPreview.text) : null;
  const markdownPreview = candidateMarkdown && Buffer.byteLength(candidateMarkdown, 'utf8') <= 32 * 1024
    ? candidateMarkdown : null;
  return {
    content: [
      { type: 'text', text: 'Publication ID: ' + transfer.token +
        '\nDownload ' + transfer.filename + ': ' + url +
        (previewUrl ? '\nPreview: ' + previewUrl : '') +
        '\nExpires: ' + new Date(transfer.expiresAt).toISOString() +
        (renderCheck ? '\nRender inspection: ' + JSON.stringify(renderCheck.inspection) +
          '\nModel: You MUST actually inspect the returned screenshots and diagnostics before sharing ANY Markdown download/preview link or calling publish_card. ' +
          'If screenshots are unavailable, incomplete for required content, or show defects, DO NOT deliver the links. ' +
          'Correct defects and re-publish; report unavailable visual review without handing off an unverified Markdown link. ' +
          'Automated checks passing does not mean the model visually reviewed the document.' : '') },
      ...(renderCheck?.screenshots || []).flatMap((screenshot, index) => [
        { type: 'text', text: 'Rendered Markdown screenshot ' + (index + 1) + ': ' + screenshot.label },
        { type: 'image', data: screenshot.data, mimeType: screenshot.mimeType },
      ]),
    ],
    structuredContent: {
      capability: 'publish',
      publication_id: transfer.token,
      ...(environmentId ? { environment_id: environmentId } : {}),
      ...metadata,
      download_url: url,
      ...(previewUrl ? { preview_url: previewUrl } : {}),
      ...(previewKind ? { preview_kind: previewKind } : {}),
      ...(textUrl ? {
        text_url: textUrl,
        text_preview: textPreview.text,
        text_truncated: textPreview.truncated,
      } : {}),
      ...(markdownPreview != null ? {
        markdown_preview: markdownPreview,
        markdown_truncated: textPreview.truncated,
      } : {}),
      ...(renderCheck ? { render_inspection: renderCheck.inspection } : {}),
      filename: transfer.filename,
      mime_type: transfer.mime_type,
      byte_length: transfer.byte_length,
      sha256: transfer.sha256,
      expires_at: new Date(transfer.expiresAt).toISOString(),
    },
  };
}

async function publishedCardResult(runtime, publicationId) {
  const acquired = runtime.fileTransferStore?.acquire(publicationId);
  if (!acquired) throw new Error('Publication not found or expired; call publish again.');
  try {
    const chunks = [];
    for await (const chunk of acquired.stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== acquired.entry.byte_length) throw new Error('Published snapshot is incomplete; call publish again.');
    return await fileResourceResult({
      filename: acquired.entry.filename,
      mime_type: acquired.entry.mime_type,
      byte_length: bytes.length,
      data: bytes.toString('base64'),
    }, acquired.entry.environment_id, runtime, {}, { existingTransfer: acquired.entry });
  } finally {
    acquired.release();
  }
}

function receivedFileResult(value, environmentId) {
  return {
    content: [{
      type: 'text',
      text: 'Received ' + value.filename + ' into ' + environmentId +
        ' at ' + value.path + ' (' + value.byte_length +
        ' bytes, sha256 ' + value.sha256 + ').',
    }],
    structuredContent: {
      capability: 'import_chatgpt_file',
      environment_id: environmentId,
      path: value.path,
      filename: value.filename,
      mime_type: value.mime_type,
      byte_length: value.byte_length,
      sha256: value.sha256,
      file_id: value.file_id,
    },
  };
}

function psQuote(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

const BMG_BROWSER_TOOLS = [
  'get_windows_and_tabs',
  'chrome_navigate',
  'chrome_get_web_content',
  'chrome_read_page',
  'chrome_get_interactive_elements',
  'chrome_click_element',
  'chrome_computer',
  'chrome_fill_or_select',
  'chrome_keyboard',
  'chrome_screenshot',
  'chrome_go_back_or_forward',
  'chrome_network_debugger_start',
  'chrome_network_debugger_stop',
  'chrome_network_capture_start',
  'chrome_network_capture_stop',
  'chrome_inject_script',
  'chrome_send_command_to_inject_script',
  'chrome_console',
  'bmg_show_workspace',
  'bmg_hide_workspace',
];

function resolveWindowsEnvironment(runtime, environmentId) {
  const environment = runtime.environmentRegistry.resolve(environmentId);
  if (environment.platform !== 'windows') {
    throw new Error(
      'This specialized capability currently requires a Windows Remote Worker.',
    );
  }
  return environment;
}

function toolPath(relativePath) {
  return [
    "$root=$env:CCM_INSTALL_ROOT",
    "if(-not $root){throw 'CCM_INSTALL_ROOT is unavailable; update and restart this Remote Worker.'}",
    '$tool=Join-Path $root ' + psQuote(relativePath),
    "if(-not (Test-Path -LiteralPath $tool)){throw ('Bundled CCM tool is missing: ' + $tool)}",
  ].join('; ');
}

async function run(runtime, args, command) {
  if (!runtime.workspaceHandleManager) {
    throw new Error('Workspace handle manager is unavailable.');
  }
  const context = await runtime.workspaceHandleManager.createProjectless(
    args.environment_id,
  );
  return runtime.processManager.execCommand({
    workspace_handle: context.workspace_handle,
    cmd: command,
    yield_time_ms: args.yield_time_ms,
    max_output_tokens: args.max_output_tokens,
  });
}

export function registerSpecializedTools(registry, runtime) {
  for (const [name, schema, handler, description] of [
    ['transfer_path', {
      source_handle: z.string().uuid(),
      source_path: z.string().min(1),
      target_handle: z.string().uuid(),
      target_path: z.string().min(1),
    }, args => runtime.transferTaskManager.start(args),
    'Copy a regular file or recursive directory between two existing CCM workspace handles over WorkerHub. Source may be an absolute readable path; target must be relative to the target workspace and MUST NOT already exist. Never overwrites or deletes source; returns transfer_id to monitor.'],
    ['transfer_status', { transfer_id: z.string().uuid() },
      args => runtime.transferTaskManager.status(args.transfer_id),
      'Read progress and final outcome of a WorkerHub file/directory transfer by transfer_id.'],
    ['transfer_cancel', { transfer_id: z.string().uuid() },
      args => runtime.transferTaskManager.cancel(args.transfer_id),
      'Request cancellation of a running WorkerHub file/directory transfer and safe cleanup of its new target.'],
  ]) {
    registry.register({
      namespace: 'ccm-extra',
      name,
      provider: 'ccm-specialized',
      provenance: 'ccm-workerhub-file-transfer',

      tags: ['file', 'transfer', 'workerhub'],
      supportsParallel: false,
      description,
      inputSchema: schema,
      handler: async args => {
        try {
          const value = handler(args);
          return {
            content: [{ type: 'text', text: JSON.stringify(value) }],
            structuredContent: value,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    });
  }
  registry.register({
    namespace: 'ccm-extra',
    name: 'publish',
    provider: 'ccm-specialized',
    provenance: 'ccm-https-file-publishing',

    tags: ['file', 'attachment', 'transfer', 'gpt'],
    supportsParallel: false,
    description: [
      "Publish an immutable snapshot without an MCP App card: plan_id alone OR workspace_handle plus path. Returns publication_id, bearer-accessible HTTPS links (up to 72 hours), and Markdown screenshots/diagnostics.",
      "Deliver links by default; only publish_card(publication_id) displays the same cached snapshot. Summarize Plans rather than pasting them. Publishing does not authorize implementation.",
      "For Worker files at or below the default 12 MiB limit use publish; for larger files proactively call quark_upload even without explicit Quark request (no share link is needed). Honor an explicitly requested delivery method; report upload failures.",
      "MANDATORY Markdown/Plan gate: inspect actual screenshots and render_inspection before sharing ANY link or calling publish_card. Check formulas, line breaks, tables, overflow and coverage. Automatic pass is insufficient. If screenshots are missing, review is incomplete or defects remain, withhold all links; fix/re-publish or report blocked review.",
      "Non-Markdown files need no visual gate. Office files are download-only; Worker paths resolve from the context root. Not a native ChatGPT attachment.",
    ].join('\n\n'),
    inputSchema: z.object({
      plan_id: z.string().uuid().optional().describe('To publish a Controller Plan: supply only this durable Plan UUID.'),
      path: z.string().min(1).optional().describe('To publish a Worker file: supply its path and workspace_handle, without plan_id.'),
      workspace_handle: z.string().uuid().optional().describe('Required with path for Worker file publishing; forbidden with plan_id.'),
    }).strict().superRefine((args, ctx) => {
      if (args.plan_id != null ? (args.path != null || args.workspace_handle != null) :
          (args.path == null || args.workspace_handle == null)) {
        ctx.addIssue({ code: 'custom', message: 'Supply either plan_id alone, or both workspace_handle and path.' });
      }
    }),
    handler: async (args) => {
      try {
        if (args.plan_id != null) {
          if (!runtime.planManager) throw new Error('CCM Plan manager is unavailable.');
          const bytes = await runtime.planManager.snapshot(args.plan_id);
          return await fileResourceResult({
            filename: 'plan-' + args.plan_id + '.md',
            mime_type: 'text/markdown; charset=utf-8',
            byte_length: bytes.length,
            data: bytes.toString('base64'),
          }, null, runtime, { plan_id: args.plan_id });
        }
        const value = await runtime.fileService.sendFile({ workspace_handle: args.workspace_handle, path: args.path });
        return await fileResourceResult(
          value,
          value.environment_id,
          runtime,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    namespace: 'ccm-extra',
    name: 'publish_card',
    provider: 'ccm-specialized',
    provenance: 'ccm-https-file-publishing',
    tags: ['file', 'attachment', 'transfer', 'gpt', 'card'],
    mcpMeta: {
      ui: { resourceUri: PUBLISHED_FILE_UI_URI },
      'openai/outputTemplate': PUBLISHED_FILE_UI_URI,
    },
    supportsParallel: false,
    description: [
      "Show an MCP App card for an existing immutable publication_id from publish. Reuses the cached snapshot and URLs; never re-reads the source.",
      "For Markdown/Plans, call ONLY after actual screenshot/diagnostic review passes, including adequate coverage. If expired, re-publish and review again; never show an unreviewed Markdown card.",
    ].join('\n\n'),
    inputSchema: z.object({
      publication_id: z.string().uuid().describe('Exact immutable publication_id returned by publish; expires with its cached file.'),
    }).strict(),
    handler: async ({ publication_id }) => {
      try {
        return await publishedCardResult(runtime, publication_id);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    namespace: 'ccm-extra',
    name: 'import_chatgpt_file',
    mcpMeta: { 'openai/fileParams': ['file'] },
    provider: 'ccm-specialized',
    provenance: 'ccm-native-file-transfer',

    tags: ['file', 'attachment', 'transfer', 'gpt', 'receive'],
    environmentRequirements: {
      capabilities: ['receiveFile'],
    },
    supportsParallel: false,
    description: [
      'Import exactly one ChatGPT file into the Worker selected by workspace_handle; multiple imports must be sequential.',
      'For an ordinary conversation attachment, bind the native file directly to the file parameter.',
      'For a ChatGPT Library file, materialize it as raw_file with ChatGPT Files, then bind the native file directly to the file parameter.',
      'Do not pass a Library/file ID, ref, or URI in place of the native file object.',
      'workspace_handle is required and determines the Worker and context root. Imports write only inside that root. destination must be relative; absolute paths and workspace escapes are rejected.',
      'If destination is omitted, the sanitized ChatGPT file_name is used at the context root. Existing files are not replaced unless overwrite=true.',
      'The Worker downloads the temporary ChatGPT URL directly; CCM does not route the file bytes through BMG or the Controller file-transfer cache.',
    ].join('\\n\\n'),
    inputSchema: {
      file: z.object({
        download_url: z.string().url(),
        file_id: z.string().min(1),
        mime_type: z.string().optional(),
        file_name: z.string().optional(),
      }).strict().describe(
        'Exactly one ChatGPT file object. For multiple files, invoke import_chatgpt_file sequentially once per file; do not call in parallel.',
      ),
      workspace_handle: z.string().uuid().describe(
        'Existing workspace handle used to determine the target Worker and context root.',
      ),
      destination: z.string().min(1).optional().describe(
        'Optional path relative to the selected context root. Absolute paths and workspace escapes are rejected. Defaults to the sanitized ChatGPT file_name.',
      ),
      overwrite: z.boolean().optional().describe(
        'Replace an existing regular file at destination. Defaults to false.',
      ),
    },
    handler: async (args) => {
      try {
        const value = await runtime.fileService.receiveFile({
          workspace_handle: args.workspace_handle,
          file: args.file,
          destination: args.destination,
          overwrite: args.overwrite === true,
        });
        return receivedFileResult(value, value.environment_id);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    namespace: 'ccm-extra',
    name: 'conversation',
    provider: 'ccm-specialized',
    provenance: 'ccm-conversation-reader',

    tags: ['chatgpt', 'codex', 'conversation', 'thread', 'share', 'import', 'read', 'export'],
    environmentRequirements: { capabilities: ['exec'] },
    supportsParallel: true,
    description: [
      "Read ChatGPT shared conversation links (聊天分享链接、共享对话), Codex shares and local Codex thread history. No workspace entry needed. For https://chatgpt.com/share/... or https://chatgpt.com/s/cx_... first import, then use conversation_id for thread/read, list or export. Re-import only to refresh.",
      "Cloud Work shares may expose only rendered messages. Serialized ChatGPT shares can include tool records whose actual outputs are redacted: check redacted_tool_result_count, never treat a tool record as its original result. Local Codex history uses thread_id and environment_id. Lists are paginated; exports support Markdown/JSON. Do not use web search, browsing or BMG to retrieve shares; unavailable upstream content cannot be reconstructed.",
    ].join('\n\n'),
    inputSchema: {
      action: z.enum(['import', 'thread/read', 'thread/turns/list', 'thread/items/list', 'export']),
      share_url: z.string().url().optional().describe('Public ChatGPT or Codex share URL, required for import.'),
      proxy: z.string().url().optional().describe('Optional HTTP(S) proxy for importing a public shared conversation.'),
      conversation_id: z.string().min(1).optional().describe('Opaque conversation ID returned by import or thread/read.'),
      thread_id: z.string().uuid().optional().describe('Local Codex thread UUID; alternative to conversation_id for read/export.'),
      environment_id: z.string().optional().describe('CCM Worker storing the snapshot or local Codex history.'),
      branch: z.enum(['active', 'all']).optional().describe('ChatGPT share branch selection at import time; both branches are retained in the raw snapshot.'),
      turn_id: z.string().optional().describe('Filter thread/items/list to one turn.'),
      cursor: z.string().optional().describe('Opaque pagination cursor from the preceding list response.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum items per page (default 20).'),
      sort_direction: z.enum(['asc', 'desc']).optional(),
      mode: z.enum(['text', 'full']).optional().describe('Readability vs source-record fidelity.'),
      format: z.enum(['md', 'json']).optional().describe('Export file format.'),
      output_path: z.string().min(1).optional().describe('Export filename relative to the Worker ignored .cache/conversation directory.'),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        if (!environment.capabilities?.conversation) {
          throw new Error('Environment does not support conversation reading: ' + environment.id);
        }
        if (args.action === 'import' && !args.share_url) {
          throw new Error('share_url is required for import.');
        }
        if (args.action !== 'import' && !(args.conversation_id || args.thread_id)) {
          throw new Error('conversation_id or thread_id is required.');
        }
        const value = await runtime.workerHub.call(environment.id, 'conversation', {
          ...args, environment_id: environment.id,
        }, { timeoutMs: 150_000 });
        return {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: { capability: 'conversation', ...value },
        };
      } catch (error) { return toolError(error); }
    },
  });

  registry.register({
    namespace: 'ccm-extra',
    name: 'quark_upload',
    provider: 'ccm-specialized',
    provenance: 'ported-from-wcm/tools/quark-transfer',

    tags: ['quark', 'cloud', 'upload', 'transfer', 'windows'],
    environmentRequirements: {
      platform: 'windows',
      capabilities: ['exec'],
      localSoftware: ['QuarkCloudDrive'],
    },
    description: [
      'Upload one or more files through the logged-in Quark Cloud Drive desktop client on the selected Windows Remote Worker.',
      'When the user asks to upload known local files to Quark Cloud Drive, call this tool directly after resolving the intended local paths.',
      'The bundled WCM-derived helper uses Quark Desktop local APIs and its in-memory WSG/account mapping. It does not print or persist account secrets.',
      'By default it waits until every upload reports completion, 100% progress, and matching local/remote sizes. Long uploads may return a live session; poll that session with write_stdin, reusing the returned workspace_handle and session_id.',
      'Current implementation accepts files only, not directories.',
    ].join('\n\n'),
    inputSchema: {
      paths: z.array(z.string().min(1)).min(1).max(32).describe(
        'Absolute or environment-native file paths to upload.',
      ),
      environment_id: z.string().optional().describe(
        'Windows Remote Worker environment. Omit to use the default environment.',
      ),
      timeout_seconds: z.number().positive().max(86_400).optional().describe(
        'Maximum time the Quark helper waits for completion. Defaults to 1800 seconds.',
      ),
      no_wait: z.boolean().optional().describe(
        'Submit the upload and return after Quark accepts it instead of waiting for completion.',
      ),
      yield_time_ms: z.number().int().min(0).max(30_000).optional().describe(
        'How long CCM waits before returning a live process session. Defaults to 10000 ms.',
      ),
      max_output_tokens: z.number().int().min(256).max(10_000).optional(),
    },
    handler: async (args) => {
      try {
        const environment = resolveWindowsEnvironment(
          runtime,
          args.environment_id,
        );
        const pathArgs = args.paths.map(psQuote).join(' ');
        const timeout = Number(args.timeout_seconds || 1800);
        const command = [
          toolPath('tools\\quark-transfer\\cloud_transfer.py'),
          "$python=(Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source",
          "if(-not $python){throw 'Python is required for the bundled Quark transfer tool.'}",
          "$env:PYTHONUTF8='1'",
          '& $python $tool upload ' + pathArgs +
            ' --timeout ' + timeout +
            (args.no_wait ? ' --no-wait' : '') +
            ' --json',
        ].join('; ');
        return execResult(await run(runtime, args, command), {
          environment_id: environment.id,
          capability: 'quark_upload',
          destination: 'Quark system manual_upload',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });




  return registry;
}

