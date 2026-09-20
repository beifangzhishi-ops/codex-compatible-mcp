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

function fileResourceResult(value, environmentId) {
  const uri = 'ccm-file:///' + encodeURIComponent(value.filename);
  return {
    content: [
      {
        type: 'text',
        text: 'Attached ' + value.filename + ' from ' + environmentId +
          ' (' + value.byte_length + ' bytes, sha256 ' + value.sha256 + ').',
      },
      {
        type: 'resource',
        resource: {
          uri,
          mimeType: value.mime_type,
          blob: value.data,
          _meta: {
            filename: value.filename,
            byte_length: value.byte_length,
            sha256: value.sha256,
            source_environment_id: environmentId,
          },
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

function psQuote(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

const BMG_BROWSER_TOOLS = [
  'get_windows_and_tabs',
  'chrome_navigate',
  'chrome_get_web_content',
  'chrome_get_interactive_elements',
  'chrome_click_element',
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
  return runtime.processManager.execCommand({
    environment_id: args.environment_id,
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
    tags: ['file', 'attachment', 'preview', 'transfer', 'gpt'],
    environmentRequirements: {
      capabilities: ['sendFile'],
    },
    supportsParallel: true,
    description: [
      'Send a file from a CCM environment to the GPT client as an embedded binary resource for preview or download.',
      'This preserves the original file bytes and does not use BMG or upload the file to ChatGPT Library.',
      'Use this for Word, PDF, Excel, PowerPoint, archives, images, and other local files after locating the exact path.',
    ].join('\n\n'),
    inputSchema: {
      path: z.string().min(1).describe(
        'File path relative to the environment cwd, or an absolute native path.',
      ),
      environment_id: z.string().optional().describe(
        'CCM environment that owns the file. Omit to use the default environment.',
      ),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        if (!environment.capabilities?.sendFile) {
          throw new Error(
            'Environment does not support send_file: ' + environment.id,
          );
        }
        const value = await runtime.fileService.sendFile({
          environment_id: environment.id,
          path: args.path,
        });
        return fileResourceResult(value, environment.id);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    namespace: 'ccm-extra',
    name: 'quark_probe',
    provider: 'ccm-specialized',
    provenance: 'ported-from-wcm/tools/quark-transfer',
    surfaces: { deferred: true, codeMode: true },
    tags: ['quark', 'cloud', 'upload', 'probe', 'windows'],
    environmentRequirements: {
      platform: 'windows',
      capabilities: ['exec'],
      localSoftware: ['QuarkCloudDrive'],
    },
    supportsParallel: true,
    description: [
      'Probe the local Quark Cloud Drive desktop client on a Windows Remote Worker.',
      'Uses only the login state already held by the local Quark desktop client. It checks the Desktop service, WSG component, current-account mapping, and upload task database without exporting cookies or credentials.',
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().optional().describe(
        'Windows Remote Worker environment. Omit to use the default environment.',
      ),
      yield_time_ms: z.number().int().min(0).max(30_000).optional(),
      max_output_tokens: z.number().int().min(256).max(10_000).optional(),
    },
    handler: async (args) => {
      try {
        const environment = resolveWindowsEnvironment(
          runtime,
          args.environment_id,
        );
        const command = [
          toolPath('tools\\quark-transfer\\cloud_transfer.py'),
          "$python=(Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source",
          "if(-not $python){throw 'Python is required for the bundled Quark transfer tool.'}",
          "$env:PYTHONUTF8='1'",
          '& $python $tool probe --json',
        ].join('; ');
        return execResult(await run(runtime, args, command), {
          environment_id: environment.id,
          capability: 'quark_probe',
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
    name: 'bmg_call',
    provider: 'ccm-external-adapter',
    provenance: 'optional-external-bmg-cli',
    surfaces: { deferred: true, codeMode: true },
    tags: ['bmg', 'browser', 'gpt', 'chatgpt', 'plugin', 'oauth', 'windows'],
    environmentRequirements: {
      platform: 'windows',
      capabilities: ['exec'],
      localSoftware: ['BMG (optional)'],
    },
    description: [
      'Invoke an allowlisted browser operation through the optional external Browser MCP Gateway (BMG) client.',
      'BMG owns the authenticated browser account state and routes page operations into its dedicated hidden GPT workspace. CCM does not read browser cookies, BMG OAuth state, local approval secrets, or BMG repository files.',
      'If BMG is not installed/configured, only this capability fails; all other CCM tools remain available. Set CCM_BMG_CLIENT to the bmgctl executable when it is not on PATH.',
      'Use bmg_show_workspace only when human login, consent, CAPTCHA, or verification is required; use bmg_hide_workspace afterwards.',
    ].join('\n\n'),
    inputSchema: {
      tool: z.enum(BMG_BROWSER_TOOLS).describe(
        'BMG browser operation to execute in the dedicated GPT workspace.',
      ),
      arguments: z.record(z.string(), z.unknown()).optional().describe(
        'Arguments forwarded to the selected BMG browser tool.',
      ),
      environment_id: z.string().optional().describe(
        'Windows Remote Worker that has BMG installed. Omit to use the default environment.',
      ),
      yield_time_ms: z.number().int().min(0).max(30_000).optional(),
      max_output_tokens: z.number().int().min(256).max(10_000).optional(),
    },
    handler: async (args) => {
      try {
        const environment = resolveWindowsEnvironment(
          runtime,
          args.environment_id,
        );
        const encodedArguments = Buffer.from(
          JSON.stringify(args.arguments || {}),
          'utf8',
        ).toString('base64');
        const command = [
          '$client=$env:CCM_BMG_CLIENT',
          "if(-not $client){$resolved=Get-Command bmgctl.cmd -ErrorAction SilentlyContinue | Select-Object -First 1; if(-not $resolved){$resolved=Get-Command bmgctl -ErrorAction SilentlyContinue | Select-Object -First 1}; if($resolved){$client=$resolved.Source}}",
          "if(-not $client){throw 'BMG is not installed or configured for this worker. Install browser-mcp-gateway and set CCM_BMG_CLIENT to bmgctl.cmd. Other CCM tools do not require BMG.'}",
          '& $client call ' + psQuote(args.tool) +
            ' --args-base64 ' + psQuote(encodedArguments),
        ].join('; ');
        return execResult(await run(runtime, args, command), {
          environment_id: environment.id,
          capability: 'bmg_call',
          bmg_tool: args.tool,
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
