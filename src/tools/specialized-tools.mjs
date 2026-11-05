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
      surfaces: { deferred: true, codeMode: true },
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
    surfaces: { direct: true, codeMode: true },
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
    provider: 'ccm-specialized',
    provenance: 'ccm-native-file-transfer',
    surfaces: { deferred: true, codeMode: true },
    tags: ['file', 'attachment', 'transfer', 'gpt', 'receive'],
    environmentRequirements: {
      capabilities: ['receiveFile'],
    },
    supportsParallel: false,
    description: [
      'Import exactly one ChatGPT file into the Worker selected by workspace_handle; multiple imports must be sequential.',
      'For an ordinary conversation attachment, bind it through exec\'s top-level file parameter, then call ccm-extra.import_chatgpt_file once; exec injects the resolved native file object into this nested call.',
      'For a ChatGPT Library file, first materialize the exact Library object as raw_file with ChatGPT Files, then bind that materialized file through top-level exec.file and call ccm-extra.import_chatgpt_file once.',
      'Do not pass a Library/file ID, ref, or URI as nested arguments.file.',
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
    name: 'chatgpt_share_export',
    provider: 'ccm-specialized',
    provenance: 'ccm-chatgpt-share-parser',
    surfaces: { deferred: true, codeMode: true },
    tags: ['chatgpt', 'codex', 'share', 'conversation', 'export', 'markdown', 'json'],
    environmentRequirements: { capabilities: ['exec'] },
    supportsParallel: true,
    description: [
      '读取和导出公开 ChatGPT 共享会话（https://chatgpt.com/share/...）及 Codex 共享会话（https://chatgpt.com/s/cx_...），无需 BMG 或浏览器自动化。',
      'For public ChatGPT Share or Codex shared-conversation links, use this capability through tool_search -> exec to inspect, extract, compare, or export the conversation. Do not use web search, web browsing, BMG, or browser automation to retrieve the conversation; report retrieval failures rather than silently switching methods.',
      'Fetches the Share HTML, decodes the indexed React Router payload, reconstructs the active parent/child branch, and exports visible user/assistant messages to Markdown or JSON.',
      'Use branch=all for forensic/debug export of all mapping nodes. Use mode=text for readable messages only, or mode=full to preserve every available message record and tool/internal payload exposed by the Share data.',
      'Codex 通过公开共享快照接口读取 version=1 的 turns/items。mode=text 保留用户消息及助手的进度和最终回复；mode=full 额外保留推理摘要、文件修改和图片项，JSON 同时保留原始快照及元数据。Codex 快照没有消息分支，branch=active 和 branch=all 均按快照原始顺序导出。无法恢复共享快照上游省略的工具调用或文件修改。',
    ].join('\n\n'),
    inputSchema: {
      share_url: z.string().url().describe('公开 ChatGPT https://chatgpt.com/share/... 或 Codex https://chatgpt.com/s/cx_<32位小写十六进制> 共享链接。'),
      output_path: z.string().min(1).optional().describe('Optional output path. Relative paths are stored under the Git-ignored .cache/chatgpt-share-export directory; absolute paths are used as provided. If omitted, CCM generates a cache filename.'),
      format: z.enum(['md', 'json']).optional().describe('Export format. Defaults to md.'),
      branch: z.enum(['active', 'all']).optional().describe('ChatGPT：active 重建当前分支，all 导出所有消息节点。Codex：两者均导出同一个线性共享快照。'),
      mode: z.enum(['text', 'full']).optional().describe('text 导出可读的用户及助手消息；full 保留共享数据中的全部记录，Codex 的 JSON 输出额外包含原始快照。默认 text。'),
      proxy: z.string().url().optional().describe('Optional HTTP(S) proxy URL, for example http://127.0.0.1:7890.'),
      environment_id: z.string().optional().describe('CCM environment used for network fetch and output.'),
      yield_time_ms: z.number().int().min(0).max(30_000).optional(),
      max_output_tokens: z.number().int().min(256).max(10_000).optional(),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        if (!environment.capabilities?.exec) throw new Error('Environment does not support exec: ' + environment.id);
        const command = [
          toolPath('tools\\chatgpt-share-export\\export.py'),
          "$python=(Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source",
          "if(-not $python){throw 'Python is required for the bundled ChatGPT Share export tool.'}",
          "$env:PYTHONUTF8='1'",
          args.proxy ? ('$env:HTTP_PROXY=' + psQuote(args.proxy) + '; $env:HTTPS_PROXY=' + psQuote(args.proxy)) : '',
          '& $python $tool ' + psQuote(args.share_url) +
            ' --format ' + psQuote(args.format || 'md') +
            ' --branch ' + psQuote(args.branch || 'active') +
            (args.output_path ? ' --output ' + psQuote(args.output_path) : '') +
            ' --mode ' + psQuote(args.mode || 'text'),
        ].filter(Boolean).join('; ');
        return execResult(await run(runtime, args, command), {
          environment_id: environment.id,
          capability: 'chatgpt_share_export',
        });
      } catch (error) { return toolError(error); }
    },
  });

  registry.register({
    namespace: 'ccm-extra',
    name: 'gmail',
    provider: 'ccm-specialized',
    provenance: 'google-gmail-api',
    surfaces: { deferred: true, codeMode: true },
    tags: ['gmail', 'google', 'email', 'mail', 'search', 'read', 'oauth'],
    environmentRequirements: {
      platform: 'windows',
      capabilities: ['exec'],
      localSoftware: ['Python', 'Google OAuth Python libraries', 'requests'],
    },
    description: [
      'Access Gmail through the official Gmail API using OAuth credentials stored on the selected CCM worker.',
      'Supports profile lookup, message search, and message reads. Authentication material stays on the worker and is never returned by this tool.',
      'Configure CCM_GMAIL_CREDENTIALS and CCM_GMAIL_TOKEN, or place credentials.json and token.json under %USERPROFILE%\\.ccm\\gmail.',
      'For restricted networks, set CCM_GMAIL_PROXY or standard HTTP(S)_PROXY variables; the bundled helper can also reuse RCLONE_HTTP_PROXY as a fallback.',
    ].join('\n\n'),
    inputSchema: {
      action: z.enum(['profile', 'search', 'read']),
      query: z.string().optional().describe('Gmail search query; required for search.'),
      message_id: z.string().optional().describe('Gmail message id; required for read.'),
      max_results: z.number().int().min(1).max(100).optional().describe('Maximum search results. Defaults to 20.'),
      environment_id: z.string().optional().describe('Windows Remote Worker with Gmail OAuth files.'),
      yield_time_ms: z.number().int().min(0).max(30_000).optional(),
      max_output_tokens: z.number().int().min(256).max(10_000).optional(),
    },
    handler: async (args) => {
      try {
        const environment = resolveWindowsEnvironment(runtime, args.environment_id);
        if (args.action === 'search' && !args.query) throw new Error('query is required for Gmail search.');
        if (args.action === 'read' && !args.message_id) throw new Error('message_id is required for Gmail read.');
        const command = [
          toolPath('tools\\gmail-api\\gmail_api.py'),
          "$python=(Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source",
          "if(-not $python){throw 'Python is required for the bundled Gmail API tool.'}",
          "$env:PYTHONUTF8='1'",
          '& $python $tool ' + psQuote(args.action) +
            (args.query ? ' --query ' + psQuote(args.query) : '') +
            (args.message_id ? ' --message-id ' + psQuote(args.message_id) : '') +
            ' --max-results ' + Number(args.max_results || 20),
        ].join('; ');
        return execResult(await run(runtime, args, command), {
          environment_id: environment.id,
          capability: 'gmail',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });



  registry.register({
    namespace: 'ccm-extra',
    name: 'quark_upload',
    provider: 'ccm-specialized',
    provenance: 'ported-from-wcm/tools/quark-transfer',
    surfaces: { deferred: true, codeMode: true },
    tags: ['quark', 'cloud', 'upload', 'transfer', 'windows'],
    environmentRequirements: {
      platform: 'windows',
      capabilities: ['exec'],
      localSoftware: ['QuarkCloudDrive'],
    },
    description: [
      'Upload one or more files through the logged-in Quark Cloud Drive desktop client on the selected Windows Remote Worker.',
      'When the user asks to upload known local files to Quark Cloud Drive, discover this capability through tool_search and invoke it through exec after resolving the intended local paths.',
      'The bundled WCM-derived helper uses Quark Desktop local APIs and its in-memory WSG/account mapping. It does not print or persist account secrets.',
      'By default it waits until every upload reports completion, 100% progress, and matching local/remote sizes. Long uploads may return a live session; poll that session through exec with nested ccm.write_stdin, reusing the returned workspace_handle and session_id.',
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
    surfaces: { deferred: true, codeMode: true },
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
      'BROWSER PLAYBACK SAFETY IS MANDATORY, NOT A FINAL OPTIONAL STEP: prefer a logged-in non-video Bilibili page for authenticated API fetches; there is no need to play the requested video to obtain DASH. If the chosen tab is already a video page, or you navigate to a video page, IMMEDIATELY use BMGCTL chrome_javascript on that exact tabId to pause EVERY video element and verify `video.paused === true`, BEFORE doing anything else. Repeat before leaving the browser, including on errors/tests/early exits. NEVER leave autoplay running, close pre-existing user tabs, or pause a different tab. The downloader also performs a fail-closed automatic pause/verification for browser_tab_id BEFORE downloading, so no final model reminder is required for completed handoffs; failures before calling the downloader still require immediate browser cleanup.',
      'BRIDGE IS REQUIRED: BMGCTL redacts signed DASH URLs. For an existing 6v projectless workspace_handle, start tools/bilibili-download/bridge.py via CCM exec_command with the SAME handle and --projectless-handoff. The Bridge writes .bilibili-dash-urls.json in that projectless workspace. Call this tool with workspace_handle and an output_path MP4 filename: the Python downloader reads and deletes that file from the same workspace, without a new handle. If no existing handle is used, the shared Bridge mode still writes to ignored .cache/bilibili-download/dash_urls.json under CCM install root, and this download tool creates its own projectless handle. Never mix these two handoff modes.',
      'In the BMGCTL logged-in Bilibili tab use chrome_javascript to POST JSON {video_url,audio_url,expected_height} from actual selected DASH representations directly to http://127.0.0.1:8765/dash with Content-Type application/json. Require HTTP 204 and BRIDGE_RECEIVED; never print signed URLs in tool results. The one-shot Bridge transfers only to a local file; the Worker consumes and deletes that file, downloads via curl.exe, remuxes with ffmpeg -c copy, and checks ffprobe video height and audio presence. Do not call before Bridge success. Never export cookies, SESSDATA, or credentials. Follow Bilibili account permissions.',
      'Long downloads may return a live session; poll through exec with nested ccm.write_stdin, reusing workspace_handle and session_id.',
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

