import * as z from 'zod/v4';

const SIX_V = 'DESKTOP-KFL6V1F';
const CLI_DEFINITIONS = [
  {
    name: 'qq',
    description: 'Directly invoke the QQBridge qq.exe CLI on 6v. Pass arguments verbatim in args, e.g. ["recent","count=10"], ["history-group","group_id=123","count=15"], ["help"]. This is the QQ workflow; do not use a terminal or UI automation. stdout/stderr and exit code are returned without parsing or retrying.',
  },
  {
    name: 'wechat',
    description: 'Directly invoke WXBridge.exe on 6v. Pass CLI arguments verbatim in args, e.g. ["chats"], ["messages","--chat","name"], ["files","--chat","name"], ["moments"]. The Bridge is read-only; do not use mouse/keyboard automation. Preserve raw stdout/stderr and errors.',
  },
  {
    name: 'sjtu_mail',
    description: 'Directly invoke the 6v Himalaya CLI for the Shanghai Jiao Tong University email account. Pass its CLI argument tokens verbatim in args, e.g. ["envelope","list"], ["--help"]. No Gmail fallback; output, errors, and exit status are passed through unparsed.',
  },
  {
    name: 'transcribe',
    description: 'Run local Faster Whisper transcription on a Windows Worker (6v by default, or specify environment_id). This is an audio-file transcriber, not a downloader. args are passed to the bundled minimal CLI: ["C:\\\\path\\\\audio.mp3", "--model", "large-v3-turbo", "--language", "ja"]. Its stdout is the original JSON transcript including timestamps, and Python traceback/stderr is returned as-is. No shell, UI, or alternate transcription provider.',
  },
];

function rawCliResult(value) {
  if (value.missing) {
    return {
      content: [{ type: 'text', text: '不存在' }],
      structuredContent: { missing: true },
      isError: true,
    };
  }
  const content = [];
  if (value.stdout) content.push({ type: 'text', text: value.stdout });
  if (value.stderr) content.push({ type: 'text', text: value.stderr });
  if (!content.length) content.push({ type: 'text', text: '' });
  const failed = value.exit_code !== 0 || value.timed_out || value.output_limit_exceeded;
  return {
    content,
    structuredContent: value,
    ...(failed ? { isError: true } : {}),
  };
}

export function registerCliTools(registry, runtime) {
  for (const definition of CLI_DEFINITIONS) {
    const transcribe = definition.name === 'transcribe';
    registry.register({
      namespace: 'ccm-extra',
      name: definition.name,
      provider: 'ccm-cli-passthrough',
      provenance: 'user-configured-local-cli',
      tags: ['cli', definition.name, 'windows'],
      supportsParallel: true,
      environmentRequirements: { platform: 'windows' },
      description: definition.description,
      inputSchema: {
        args: z.array(z.string()).max(128).default([])
          .describe('Native CLI argument tokens. Pass a separate string for each token; no shell quoting or command line string.'),
        ...(transcribe ? {
          environment_id: z.string().optional().describe('Windows Worker hosting Faster Whisper. Omit for 6v.'),
        } : {}),
        timeout_seconds: z.number().int().min(1).max(3600).optional()
          .describe(transcribe ? 'Maximum transcription duration in seconds (default 3600).' : 'Maximum CLI duration in seconds (default 120).'),
      },
      handler: async (args) => {
        try {
          const environment = runtime.environmentRegistry.resolve(
            transcribe ? (args.environment_id || SIX_V) : SIX_V,
          );
          if (environment.platform !== 'windows') {
            throw new Error('This tool requires a Windows Worker.');
          }
          const value = await runtime.workerHub.call(
            environment.id,
            'cli_passthrough',
            {
              tool: definition.name,
              args: args.args ?? [],
              timeout_seconds: args.timeout_seconds ?? (transcribe ? 3600 : 120),
              environment_id: environment.id,
            },
            { timeoutMs: 1000 * (args.timeout_seconds ?? (transcribe ? 3600 : 120)) + 10_000 },
          );
          return rawCliResult(value);
        } catch (error) {
          return { content: [{ type: 'text', text: String(error?.message || error) }], isError: true };
        }
      },
    });
  }
  return registry;
}
