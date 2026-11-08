import * as z from 'zod/v4';
import { PUBLISHED_FILE_UI_URI } from '../ui/published-file-app.mjs';
import { textPreviewFromBase64 } from '../controller/text-file-preview.mjs';
import { publishedPreviewKind } from '../controller/published-file-preview.mjs';
import { renderMarkdownFragment } from '../controller/markdown-preview.mjs';
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

function fileResourceResult(value, environmentId, runtime, metadata = {}) {
  const fileTransferStore = runtime.fileTransferStore;
  if (!fileTransferStore) {
    throw new Error('CCM file-transfer store is unavailable.');
  }
  const origin = runtime.fileDownloadOrigin();
  if (!/^https:\/\//.test(origin)) throw new Error('Valid HTTPS file origin is required.');
  const transfer = fileTransferStore.put(value, { environmentId });
  const url = origin + '/ccm/download/' + transfer.token;
  const previewKind = publishedPreviewKind(transfer.mime_type);
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
    content: [{ type: 'text', text: 'Download ' + transfer.filename + ': ' + url +
      (previewUrl ? '\nPreview: ' + previewUrl : '') +
      '\nExpires: ' + new Date(transfer.expiresAt).toISOString() }],
    structuredContent: {
      capability: 'publish',
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
      filename: transfer.filename,
      mime_type: transfer.mime_type,
      byte_length: transfer.byte_length,
      sha256: transfer.sha256,
      expires_at: new Date(transfer.expiresAt).toISOString(),
    },
  };
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
    mcpMeta: {
      ui: { resourceUri: PUBLISHED_FILE_UI_URI },
      'openai/outputTemplate': PUBLISHED_FILE_UI_URI,
    },
    supportsParallel: false,
    description: [
      'Publish exactly one resource: either a Controller-hosted durable Plan using only plan_id, or a Worker file using both workspace_handle and path. These input modes are mutually exclusive; never supply plan_id together with path or workspace_handle. The original content is published as a fixed snapshot in a temporary HTTPS download link (up to 72 hours) with one MCP App card. Markdown is rendered as safe HTML in the card (bounded excerpt) and full browser preview, while the original .md stays downloadable. Other UTF-8 text/JSON/code uses a source snippet and full-text link. Browser-native images, PDF, audio/video and isolated HTML/SVG have preview links. This is not a native ChatGPT attachment.',
      'When planning reaches a decision-complete stopping point, publish the current Plan with plan_id without copying its full text into the reply. When generating user-facing artifacts, proactively publish finished deliverables and useful previews. Stage previews are permitted; do not publish files merely for model-side inspection.',
      'For Worker files, workspace_handle is required and selects the Worker; relative paths resolve from its context root, absolute paths remain absolute. Reuse an existing handle; for genuinely projectless work use create_projectless_handle and never enter/register a project merely to publish a file.',
      'view_image is only for model-side image inspection. The card keeps the download link beside any native browser preview. PDF previews use the browser PDF reader; Office files require conversion and therefore remain download-only. Avoid publishing unnecessary intermediate files.',
      'Publishing a Plan reads its entire latest persisted Markdown directly from Controller storage, without plan_read bounds, Worker access, or tracked-file writes. Every publication is an immutable snapshot, not a live Plan link. Publish one resource per call, sequentially; public links are bearer capabilities and anyone possessing them can download during their lifetime.',
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
          return fileResourceResult({
            filename: 'plan-' + args.plan_id + '.md',
            mime_type: 'text/markdown; charset=utf-8',
            byte_length: bytes.length,
            data: bytes.toString('base64'),
          }, null, runtime, { plan_id: args.plan_id });
        }
        const value = await runtime.fileService.sendFile({ workspace_handle: args.workspace_handle, path: args.path });
        return fileResourceResult(
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
      'Unified conversation tool for public ChatGPT/Codex shares and local Codex threads.',
      'For a public https://chatgpt.com/share/... or https://chatgpt.com/s/cx_... URL, first call action=import. Reuse the returned conversation_id for thread/read, thread/turns/list, thread/items/list, and export; later reads never re-fetch the public URL. Explicit repeated imports refresh the snapshot.',
      'For a local Codex session UUID, call thread/read or other read actions with thread_id and the environment_id for the machine owning that history. The Worker reads only its configured Codex Home and never resumes the thread.',
      'List operations return bounded pages and next_cursor. mode=full exposes source records where present, with large fields truncated in inline results; export produces a complete Markdown/JSON file under the Worker cache, which can then be published through ccm-extra.publish. Public share snapshots cannot reconstruct content absent upstream.',
      'Do not use web search, web browsing, BMG, or browser automation to retrieve public shared-conversation content. There is no need to register or enter a workspace for this tool.',
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



  registry.register({
    namespace: 'ccm-extra',
    name: 'bilibili_download_dash',
    provider: 'ccm-specialized',
    provenance: 'ccm-bilibili-bmgctl-dash',

    tags: [
      'bilibili',
      'video',
      'download',
      'dash',
      'ffmpeg',
      'windows',
    ],
    environmentRequirements: {
      platform: 'windows',
      capabilities: ['exec'],
      localSoftware: ['Python', 'curl', 'ffmpeg', 'ffprobe'],
    },
    description: [
      'Download authenticated Bilibili DASH media received via the local Bridge handoff on 6v; remux without re-encoding and verify the resulting video resolution.',
      'BMGCTL IS REQUIRED for discovery: on 6v invoke C:\\Users\\Songjx\\AppData\\Roaming\\npm\\bmgctl.cmd via CCM exec_command. First call `health` and `call get_windows_and_tabs --args {}`; record the exact tabId you operate, use `call chrome_navigate` / `call chrome_javascript` to operate the logged-in Bilibili browser. Use `--args-base64 BASE64` for nonempty JSON to preserve Windows command quoting. BMGCTL reuses the browser login without the BMG MCP phone-authenticator grant. Do not invoke BMG MCP tools for this workflow.',
      'Using BMGCTL browser JavaScript, verify Bilibili login (the nav API must report `code: 0` and `data.isLogin: true`). Resolve the requested BV/CID and obtain the account-authorized DASH playurl response. Select the highest actually available video representation and appropriate audio; the requested DASH qn alone does not determine the returned quality. If BMGCTL is unavailable or Bilibili login is expired, stop rather than silently using anonymous requests, yt-dlp, or reduced quality.',
      'Before downloading, the tool automatically pauses and verifies playback in the supplied browser_tab_id through BMGCTL; if that fails, the download does not start.',
      'BRIDGE IS REQUIRED: BMGCTL redacts signed DASH URLs. For an existing 6v projectless workspace_handle, start tools/bilibili-download/bridge.py via CCM exec_command with the SAME handle and --projectless-handoff. The Bridge writes .bilibili-dash-urls.json in that projectless workspace. Call this tool with workspace_handle and an output_path MP4 filename: the Python downloader reads and deletes that file from the same workspace, without a new handle. If no existing handle is used, the shared Bridge mode still writes to ignored .cache/bilibili-download/dash_urls.json under CCM install root, and this download tool creates its own projectless handle. Never mix these two handoff modes.',
      'In the BMGCTL logged-in Bilibili tab use chrome_javascript to POST JSON {video_url,audio_url,expected_height} from actual selected DASH representations directly to http://127.0.0.1:8765/dash. Use fetch with method POST, mode no-cors, and Content-Type text/plain (JSON-encoded body): this is required because the browser blocks CORS requests to the loopback Bridge. The browser response is opaque and cannot reveal HTTP status. Require the Bridge process to exit with BRIDGE_RECEIVED (it only reports this after accepting JSON and returning HTTP 204); do not count an opaque browser response alone as success. Never print signed URLs in tool results. The one-shot Bridge transfers only to a local file; the Worker consumes and deletes that file, downloads via curl.exe, remuxes with ffmpeg -c copy, and checks ffprobe video height and audio presence. Do not call before Bridge success. Never export cookies, SESSDATA, or credentials. Follow Bilibili account permissions.',
      'Long downloads may return a live session; poll with write_stdin, reusing workspace_handle and session_id.',
    ].join('\n\n'),
    inputSchema: {
      output_path: z.string().regex(/^[^\\/:*?"<>|]+\.mp4$/i).describe(
        'MP4 filename only, e.g. video.mp4. When workspace_handle is supplied, save inside that existing 6v projectless workspace; otherwise create a new one. No absolute paths or writing to another workspace. Existing files are not overwritten.',
      ),
      browser_tab_id: z.number().int().positive().describe(
        'REQUIRED exact BMGCTL tabId used for this Bilibili task, obtained from get_windows_and_tabs. The downloader will automatically pause and verify this tab before transfer; if BMGCTL is unavailable or verification fails, no download occurs.',
      ),
      workspace_handle: z.string().uuid().optional().describe(
        'Optional existing 6v projectless workspace_handle. If supplied, start the Bridge through CCM exec_command using this SAME handle with --projectless-handoff, then invoke this download tool with the handle. No new workspace is created. Omit only for the earlier shared-Bridge workflow.',
      ),
      environment_id: z.literal('DESKTOP-KFL6V1F').optional().describe(
        'The 6v Controller host: DESKTOP-KFL6V1F. The BMGCTL Bridge is local to 6v; omission also selects 6v.',
      ),
      timeout_seconds: z.number().positive().max(86_400).optional().describe(
        'Per-stream curl max time. Defaults to 900 seconds.',
      ),
      yield_time_ms: z.number().int().min(0).max(30_000).optional().describe(
        'How long CCM waits before returning a live process session. Defaults to 10000 ms.',
      ),
      max_output_tokens: z.number().int().min(256).max(10_000).optional(),
    },
    handler: async (args) => {
      try {
        const environmentId = args.environment_id || 'DESKTOP-KFL6V1F';
        if (environmentId !== 'DESKTOP-KFL6V1F') {
          throw new Error('BMGCTL Bridge handoff is only available on 6v.');
        }
        if (!Number.isSafeInteger(args.browser_tab_id) || args.browser_tab_id <= 0) {
          throw new Error('A valid BMGCTL browser_tab_id is required for automatic playback pause.');
        }
        if (args.workspace_handle) {
          const current = runtime.workspaceHandleManager.resolve(args.workspace_handle);
          if (current.workspace_kind !== 'projectless' ||
              current.environment_id !== environmentId) {
            throw new Error('Bilibili workspace_handle must be a projectless handle on 6v.');
          }
        }
        const environment = resolveWindowsEnvironment(
          runtime,
          environmentId,
        );
        const command = [
          toolPath('tools\\bilibili-download\\download-dash.py'),
          '& python.exe $tool' +
            ' --output ' + psQuote(args.output_path) +
            ' --browser-tab-id ' + Number(args.browser_tab_id) +
            (args.workspace_handle ? ' --projectless-handoff' : '') +
            ' --timeout ' + Number(args.timeout_seconds || 900),
        ].join('; ');
        const result = args.workspace_handle
          ? await runtime.processManager.execCommand({
              workspace_handle: args.workspace_handle,
              cmd: command,
              yield_time_ms: args.yield_time_ms,
              max_output_tokens: args.max_output_tokens,
            })
          : await run(runtime, { ...args, environment_id: environmentId }, command);
        return execResult(result, {
          environment_id: environment.id,
          capability: 'bilibili_download_dash',
          output_path: args.output_path,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  return registry;
}

