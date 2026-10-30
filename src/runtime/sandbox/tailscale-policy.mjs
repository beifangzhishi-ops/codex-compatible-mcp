import { effectiveShell, parseShellCommand } from './shell-policy-parser.mjs';

// Bind trusted Tailscale commands to the installed executable, never PATH,
// a workspace-local lookalike, or an arbitrary shell program.
export const TAILSCALE_EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';

const alias = /^tailscale(?:\.exe)?(?=\s|$)/i;
const literalPath = /^["']?C:\\Program Files\\Tailscale\\tailscale\.exe["']?(?=\s|$)/i;
const psCall = /^&\s+(?:'C:\\Program Files\\Tailscale\\tailscale\.exe'|"C:\\Program Files\\Tailscale\\tailscale\.exe")(?=\s|$)/i;

// Return a command with the trusted absolute executable substituted in place
// of a bare alias. CMD needs an extra outer pair of quotes for /s /c.
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
    cmd: shellKind === 'cmd'
      ? `""${TAILSCALE_EXE}"${suffix}"`
      : `& '${TAILSCALE_EXE}'${suffix}`,
  };
}
