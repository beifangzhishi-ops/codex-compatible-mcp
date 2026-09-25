import * as z from 'zod/v4';
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

function fileResourceResult(value, environmentId, fileTransferStore) {
  if (!fileTransferStore) {
    throw new Error('CCM file-transfer store is unavailable.');
  }
  const transfer = fileTransferStore.put(value, { environmentId });
  return {
    content: [
      {
        type: 'text',
        text: 'Attached ' + value.filename + ' from ' + environmentId +
          ' (' + value.byte_length + ' bytes, sha256 ' + value.sha256 + ').',
      },
      {
        type: 'resource_link',
        uri: transfer.uri,
        name: value.filename,
        description: 'File transferred from CCM environment ' + environmentId,
        mimeType: value.mime_type,
        size: value.byte_length,
        _meta: {
          sha256: value.sha256,
          source_environment_id: environmentId,
        },
      },
    ],
    structuredContent: {
      capability: 'send_file',
      environment_id: environmentId,
      path: value.path,
      filename: value.filename,
      mime_type: value.mime_type,
      byte_length: value.byte_length,
      sha256: value.sha256,
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
      capability: 'receive_file',
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
    name: 'send_file',
    provider: 'ccm-specialized',
    provenance: 'ccm-native-file-transfer',
    surfaces: { deferred: true, codeMode: true },
    tags: ['file', 'attachment', 'transfer', 'gpt'],
    environmentRequirements: {
      capabilities: ['sendFile'],
    },
    supportsParallel: false,
    description: [
      'Send exactly one file per call from a CCM environment to the GPT client as a native MCP resource link. If the user needs multiple files, call send_file sequentially and wait for each call to return before starting the next. Never issue concurrent or parallel send_file calls.',
      'Use send_file only when the user actually needs the file in chat for download, opening, upload to another tool, or handoff.',
      'workspace_context is required and determines the Worker. Relative paths are resolved from that context root; absolute paths remain absolute on the selected Worker.',
      'For a genuinely projectless task, automatically obtain a projectless context first through ccm.create_projectless_context; do not ask the user to choose or register a temporary directory. If select_workspace or register_workspace is awaiting approval for the intended real project, wait for that action to resolve and use its registered workspace_context instead.',
      'Do NOT use send_file merely so the model can inspect, review, analyze, or verify a local file. If the file can be examined inside CCM, prefer local reading, view_image, command-line inspection, or a temporary local preview instead.',
      'Before calling send_file, make it clear to the user that the file needs to be transferred into chat. This preserves the original file bytes and does not use BMG or upload the file to ChatGPT Library.',
      'After send_file succeeds, include the host-generated native ChatGPT file attachment object in the final response, not its file ID as text.',
      'Treat 1 KiB (1024 bytes) as the operational minimum for reliable ChatGPT attachment downloads. Files smaller than 1 KiB may still be transferred byte-for-byte, but some ChatGPT clients can remain stuck connecting when downloading them. Never pad, rewrite, or otherwise alter the source file to reach this threshold; warn the user instead when a sub-1-KiB file is being handed off.',
      'Use this for Word, PDF, Excel, PowerPoint, archives, images, and other local files only after locating the exact path and determining that an actual user-facing transfer is needed.',
    ].join('\n\n'),
    inputSchema: {
      path: z.string().min(1).describe(
        'Exactly one file path on the Worker selected by workspace_context. Relative paths resolve from the selected context root; absolute paths remain absolute. For multiple files, invoke send_file sequentially once per file and wait for each call to return before issuing the next; do not call send_file in parallel.',
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
          runtime.fileTransferStore,
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    namespace: 'ccm-extra',
    name: 'receive_file',
    provider: 'ccm-specialized',
    provenance: 'ccm-native-file-transfer',
    surfaces: { deferred: true, codeMode: true },
    tags: ['file', 'attachment', 'transfer', 'gpt', 'receive'],
    environmentRequirements: {
      capabilities: ['receiveFile'],
    },
    supportsParallel: false,
    description: [
      'Receive exactly one ChatGPT file per call and save it to the Worker selected by workspace_context. For multiple files, call receive_file sequentially and wait for each call to return before starting the next. Never issue concurrent or parallel receive_file calls.',
      'The file field is the already-resolved native ChatGPT file object with download_url and file_id. For a real conversation or Library attachment, bind that file through exec\'s top-level file parameter so ChatGPT resolves it before CCM injects it into this nested call.',
      'Do not substitute a file ID, URI, placeholder, sandbox path, or JSON string for the file object.',
      'workspace_context is required and determines the Worker and context root. receive_file writes only inside that context root. destination must be relative; absolute paths and workspace escapes are rejected.',
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
        'Exactly one ChatGPT file object. For multiple files, invoke receive_file sequentially once per file; do not call receive_file in parallel.',
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
    tags: ['chatgpt', 'share', 'conversation', 'export', 'markdown', 'json'],
    environmentRequirements: { capabilities: ['exec'] },
    supportsParallel: true,
    description: [
      'Export a public ChatGPT Share conversation directly from its chatgpt.com/share URL without BMG or browser automation.',
      'Fetches the Share HTML, decodes the indexed React Router payload, reconstructs the active parent/child branch, and exports visible user/assistant messages to Markdown or JSON.',
      'Use branch=all for forensic/debug export of all mapping nodes. Use mode=text for readable messages only, or mode=full to preserve every available message record and tool/internal payload exposed by the Share data.',
    ].join('\n\n'),
    inputSchema: {
      share_url: z.string().url().describe('Public https://chatgpt.com/share/... URL.'),
      output_path: z.string().min(1).optional().describe('Optional output path. Relative paths are stored under the Git-ignored .cache/chatgpt-share-export directory; absolute paths are used as provided. If omitted, CCM generates a cache filename.'),
      format: z.enum(['md', 'json']).optional().describe('Export format. Defaults to md.'),
      branch: z.enum(['active', 'all']).optional().describe('active reconstructs the final branch; all exports every mapping node.'),
      mode: z.enum(['text', 'full']).optional().describe('text exports visible user/assistant messages only; full preserves all available branch records including system/tool messages and message payload metadata. Defaults to text.'),
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
      'The bundled WCM-derived helper uses Quark Desktop local APIs and its in-memory WSG/account mapping. It does not print or persist account secrets.',
      'By default it waits until every upload reports completion, 100% progress, and matching local/remote sizes. Long uploads may return a live session; continue that session with the top-level write_stdin tool.',
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
      'The resulting media is remuxed with ffmpeg -c copy. Long downloads may return a live session; continue it with the top-level write_stdin tool.',
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

