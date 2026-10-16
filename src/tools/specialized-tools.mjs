import * as z from 'zod/v4';
import { FILE_TOKEN_RE } from '../controller/file-transfer-store.mjs';
import { PUBLISHED_IMAGE_PREVIEW_UI_URI } from '../ui/published-image-preview-app.mjs';
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

function fileResourceResult(value, environmentId, runtime) {
  const fileTransferStore = runtime.fileTransferStore;
  if (!fileTransferStore) {
    throw new Error('CCM file-transfer store is unavailable.');
  }
  const origin = runtime.fileDownloadOrigin();
  if (!/^https:\/\//.test(origin)) throw new Error('Valid HTTPS file origin is required.');
  const transfer = fileTransferStore.put(value, { environmentId });
  const url = origin + '/ccm/download/' + transfer.token;
  const previewUrl = /^image\/(png|jpeg|webp)$/i.test(transfer.mime_type)
    ? origin + '/ccm/preview/' + transfer.token : undefined;
  return {
    content: [{ type: 'text', text: 'Download ' + transfer.filename + ': ' + url +
      (previewUrl ? '\nImage preview: ' + previewUrl : '') +
      '\nExpires: ' + new Date(transfer.expiresAt).toISOString() }],
    structuredContent: {
      capability: 'publish_worker_file',
      environment_id: environmentId,
      download_url: url,
      ...(previewUrl ? { preview_url: previewUrl } : {}),
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
  if (!runtime.workspaceContextManager) {
    throw new Error('Workspace context manager is unavailable.');
  }
  const context = await runtime.workspaceContextManager.createProjectless(
    args.environment_id,
  );
  return runtime.processManager.execCommand({
    workspace_context: context.workspace_context,
    cmd: command,
    yield_time_ms: args.yield_time_ms,
    max_output_tokens: args.max_output_tokens,
  });
}

export function registerSpecializedTools(registry, runtime) {
  registry.register({
    namespace: 'ccm-extra',
    name: 'preview_published_image',
    provider: 'ccm-specialized',
    provenance: 'ccm-image-preview-experiment',
    surfaces: { direct: true },
    tags: ['image', 'preview', 'experiment'],
    mcpMeta: {
      ui: { resourceUri: PUBLISHED_IMAGE_PREVIEW_UI_URI },
      'openai/outputTemplate': PUBLISHED_IMAGE_PREVIEW_UI_URI,
    },
    description: 'Experimental MCP App image preview. Show one previously published CCM PNG/JPEG/WebP in a chat iframe to test fit and clipping. Supply the token from publish_worker_file.preview_url. Do not invoke for ordinary file publication; this is an opt-in layout test.',
    inputSchema: { token: z.string().uuid().describe('Token from an existing CCM published image URL.') },
    handler: async ({ token }) => {
      try {
        if (!FILE_TOKEN_RE.test(token)) throw Error('Invalid published image token.');
        const entry = runtime.fileTransferStore?.get(token);
        if (!entry || !/^image\/(png|jpeg|webp)$/i.test(entry.mime_type)) {
          throw Error('Published preview not found or expired.');
        }
        const origin = runtime.fileDownloadOrigin();
        if (!/^https:\/\//.test(origin)) throw Error('HTTPS file origin is unavailable.');
        const previewUrl = origin + '/ccm/preview/' + token;
        return {
          content: [{ type: 'text', text: 'CCM image preview: ' + previewUrl }],
          structuredContent: {
            capability: 'preview_published_image',
            filename: entry.filename,
            mime_type: entry.mime_type,
            preview_url: previewUrl,
            expires_at: new Date(entry.expiresAt).toISOString(),
          },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    namespace: 'ccm-extra',
    name: 'publish_worker_file',
    provider: 'ccm-specialized',
    provenance: 'ccm-https-file-publishing',
    surfaces: { direct: true, codeMode: true },
    tags: ['file', 'attachment', 'transfer', 'gpt'],
    environmentRequirements: {
      capabilities: ['sendFile'],
    },
    supportsParallel: false,
    description: [
      'Publish one known Worker file per call as a temporary public HTTPS download link (72 hours, subject to cache eviction). It is not a native ChatGPT attachment.',
      'When a user asks to create a PPT, PDF, image, report or other artifact, you may proactively publish the finished result and useful preview images for the user without a separate request to send it. Stage previews are permitted and further CCM work may continue after publishing. Do not publish files merely for model-side inspection.',
      'workspace_context is required and determines the Worker. Relative paths are resolved from that context root; absolute paths remain absolute on the selected Worker.',
      'For a genuinely projectless task, automatically obtain a projectless context first through ccm.create_projectless_context; do not ask the user to choose or register a temporary directory. If select_workspace or register_workspace is awaiting approval for the intended real project, wait for that action to resolve and use its registered workspace_context instead.',
      'view_image is only for the model to inspect images; it does not show images to the user. For PNG/JPEG/WebP, use the returned preview_url in the reply when the Host supports inline HTTPS images; otherwise provide a clickable preview link. PPT/PDF require separately rendered preview images to display visually.',
      'The original bytes are preserved. Publish one file at a time, sequentially; public links are bearer capabilities and anyone possessing them can download during their lifetime.',
    ].join('\n\n'),
    inputSchema: {
      path: z.string().min(1).describe(
        'Exactly one Worker file to publish for the user. Relative paths resolve from the selected context root; absolute paths remain absolute. Publish multiple files sequentially.',
      ),
      workspace_context: z.string().uuid().describe(
        'Existing workspace context used to determine the Worker that owns the file.',
      ),
    },
    handler: async (args) => {
      try {
        const value = await runtime.fileService.sendFile({
          workspace_context: args.workspace_context,
          path: args.path,
        });
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
      'Import exactly one ChatGPT file into the Worker selected by workspace_context; multiple imports must be sequential.',
      'For an ordinary conversation attachment, bind it through exec\'s top-level file parameter, then call ccm-extra.import_chatgpt_file once; exec injects the resolved native file object into this nested call.',
      'For a ChatGPT Library file, first materialize the exact Library object as raw_file with ChatGPT Files, then bind that materialized file through top-level exec.file and call ccm-extra.import_chatgpt_file once.',
      'Do not pass a Library/file ID, ref, or URI as nested arguments.file.',
      'workspace_context is required and determines the Worker and context root. Imports write only inside that root. destination must be relative; absolute paths and workspace escapes are rejected.',
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
      workspace_context: z.string().uuid().describe(
        'Existing workspace context used to determine the target Worker and context root.',
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
          workspace_context: args.workspace_context,
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
      'When the user provides a public ChatGPT Share URL and asks to inspect, extract, compare, or export that conversation, discover this capability through tool_search and invoke it through exec rather than BMG or browser automation.',
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
      'By default it waits until every upload reports completion, 100% progress, and matching local/remote sizes. Long uploads may return a live session; poll that session through exec with nested ccm.write_stdin, reusing the returned workspace_context and session_id.',
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
    provenance: 'ported-from-wcm/tools/bilibili-download',
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
      localSoftware: ['curl', 'ffmpeg'],
    },
    description: [
      'Download signed Bilibili DASH video and audio URLs on a Windows Remote Worker and remux them losslessly with ffmpeg.',
      'Use an authenticated browser/BMG session to obtain the Bilibili playurl response and select the desired permitted video/audio representations first. Then pass those short-lived signed URLs here. CCM does not export browser cookies or bypass Bilibili account/quality permissions.',
      'The resulting media is remuxed with ffmpeg -c copy. Long downloads may return a live session; poll that session through exec with nested ccm.write_stdin, reusing the returned workspace_context and session_id.',
    ].join('\n\n'),
    inputSchema: {
      video_url: z.string().url().describe(
        'Signed DASH video representation URL obtained from Bilibili playurl.',
      ),
      audio_url: z.string().url().describe(
        'Signed DASH audio representation URL obtained from Bilibili playurl.',
      ),
      output_path: z.string().min(1).describe(
        'Destination MP4 path on the selected Worker.',
      ),
      environment_id: z.string().optional().describe(
        'Windows Remote Worker environment. Omit to use the default environment.',
      ),
      referer: z.string().url().optional().describe(
        'HTTP Referer. Defaults to https://www.bilibili.com/.',
      ),
      user_agent: z.string().min(1).optional().describe(
        'Optional browser User-Agent. A normal desktop browser UA is used by default.',
      ),
      timeout_seconds: z.number().positive().max(86_400).optional().describe(
        'Per-stream curl max time. Defaults to 1800 seconds.',
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
        const command = [
          toolPath('tools\\bilibili-download\\download-dash.ps1'),
          '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tool' +
            ' -VideoUrl ' + psQuote(args.video_url) +
            ' -AudioUrl ' + psQuote(args.audio_url) +
            ' -OutputPath ' + psQuote(args.output_path) +
            ' -Referer ' + psQuote(
              args.referer || 'https://www.bilibili.com/',
            ) +
            (args.user_agent
              ? ' -UserAgent ' + psQuote(args.user_agent)
              : '') +
            ' -TimeoutSeconds ' + Number(args.timeout_seconds || 1800),
        ].join('; ');
        return execResult(await run(runtime, args, command), {
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

