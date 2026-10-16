import * as z from 'zod/v4';

export function registerRestartTools(registry, runtime) {
  registry.register({
    name: 'restart',
    provider: 'ccm-core',
    surfaces: { deferred: true, codeMode: true },
    supportsParallel: false,
    tags: ['restart', 'worker', 'controller', 'supervisor'],
    description: [
      'Request a controlled restart of one allowlisted CCM instance using its registered environment ID. No command, PID, executable, script, path, or extra arguments can be supplied.',
      'component=controller_service_group restarts only this Controller host service group (Controller, local Worker, OAuth sidecar); component=worker restarts only the specified connected Remote Worker. Other programs are never eligible.',
      'Allowed environment IDs come from config/restart-allowlist.json and are checked at each call. The existing Supervisor must be running. This tool only acknowledges acceptance: after it returns, independently verify that the environment reconnects and is healthy before declaring a successful restart.',
      'Discover with tool_search and invoke through exec. It does not grant any exec_command approval or persistent shell-command prefix.',
    ].join('\n\n'),
    inputSchema: z.object({
      component: z.enum(['controller_service_group', 'worker']),
      environment_id: z.string().min(1).max(256),
    }).strict(),
    handler: async (args) => {
      try {
        const value = await runtime.controlledRestart.request(args);
        return {
          content: [{ type: 'text', text: value.message }],
          structuredContent: value,
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: String(error?.message || error) }],
          isError: true,
        };
      }
    },
  });
}
