import { effectiveShell, parseShellCommand } from './shell-policy-parser.mjs';

// Bind trusted Tailscale commands to the installed executable, never PATH,
// a workspace-local lookalike, or an arbitrary shell program.
export const TAILSCALE_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';

const alias = /^tailscale(?:\.exe)?(?=\s|$)/i;
const literalPath = /^["']?C:\\Program Files\\Tailscale\\tailscale\.exe["']?(?=\s|$)/i;
const psCall = /^&\s+(?:'C:\\Program Files\\Tailscale\\tailscale\.exe'|"C:\\Program Files\\Tailscale\\tailscale\.exe")(?=\s|$)/i;

// Run the pinned executable as a literal PowerShell call. CMD /s /c can
// mis-handle the nested quotes needed for executable paths containing spaces
// after Node's Windows argument escaping. Parse CMD inputs in CMD syntax,
// then dispatch only the recognized executable call via PowerShell.
export function trustedTailscaleInvocation(command, shell, environment = {}) {
  if (environment.platform !== 'windows') return null;
  const shellKind = effectiveShell({ shell }, environment);
  if (!['powershell', 'pwsh', 'cmd'].includes(shellKind)) return null;
  // Also accept CMD's already-wrapped /s /c literal executable form.
  const cmdOuterQuoted = shellKind === 'cmd' &&
    command.toLowerCase().startsWith(`""${TAILSCALE_EXE.toLowerCase()}"`) &&
    command.endsWith('"');
  const normalizedInput = cmdOuterQuoted ? command.slice(1, -1) : command;
  const parsed = parseShellCommand(normalizedInput, { shell: shellKind });
  if (parsed?.segments.length !== 1) return null;
  const segment = parsed.segments[0];
  const source = segment.source;
  // CMD expands environment variables before executing the line. Their
  // expansion can introduce shell syntax; never elevate such command lines.
  if (shellKind === 'cmd' && /[%!^]/.test(source)) return null;
  const match = shellKind === 'cmd'
    ? (literalPath.exec(source) || alias.exec(source))
    : (psCall.exec(source) || literalPath.exec(source) || alias.exec(source));
  if (!match) return null;
  if (segment.tokens[0].toLowerCase() !== TAILSCALE_EXE.toLowerCase() &&
      !/^tailscale(?:\.exe)?$/i.test(segment.tokens[0])) return null;
  const suffix = source.slice(match[0].length);
  return {
    cmd: `& '${TAILSCALE_EXE}'${suffix}`,
    ...(shellKind === 'cmd' ? { shell: 'powershell.exe' } : {}),
  };
}

const TAILSCALE_PIPE_DENIED = /failed to connect to local tailscaled[^\r\n]*(?:Access is denied|拒绝访问)/i;

const TAILSCALE_ALLOWLIST_HINT = [
  '[CCM Tailscale sandbox hint] Tailscale local service access was denied.',
  'Built-in no-approval Tailscale allowlist (Windows workspace-write, each as a standalone exec_command):',
  '  PowerShell / pwsh: tailscale status',
  '  PowerShell / pwsh: tailscale.exe status',
  `  PowerShell / pwsh: & '${TAILSCALE_EXE}' status`,
  `  PowerShell / pwsh: & "${TAILSCALE_EXE}" status`,
  '  CMD: tailscale status',
  '  CMD: tailscale.exe status',
  `  CMD: "${TAILSCALE_EXE}" status`,
  'The examples use status; other Tailscale CLI arguments are also supported.',
  'Invoke the Tailscale command alone in a new exec_command call. Run other diagnostics in separate calls; do not combine them with ;, &&, |, or redirection.',
].join('\n');

// A compound script can emit a local-service denial and still exit with 0 if
// its last command succeeded. Diagnose the precise pipe failure rather than
// relying on exit_code, and never mistake DNS health warnings for this case.
export function tailscaleSandboxDenialHint({ command, output, environment, trusted = false }) {
  if (trusted || environment?.platform !== 'windows' ||
      environment?.permissionProfile !== 'workspace-write') return null;
  if (!/\btailscale(?:\.exe)?\b/i.test(command || '') ||
      !TAILSCALE_PIPE_DENIED.test(output || '')) return null;
  return TAILSCALE_ALLOWLIST_HINT;
}
