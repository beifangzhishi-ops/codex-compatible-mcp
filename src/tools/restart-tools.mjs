import * as z from 'zod/v4';

export function registerRestartTools(registry, runtime) {
  registry.register({
    name: 'restart',
    provider: 'ccm-core',

    supportsParallel: false,
    tags: ['restart', 'worker', 'controller', 'supervisor'],
    description: [
      'Request a controlled restart of one allowlisted CCM instance using its registered environment ID. No command, PID, executable, script, path, or extra arguments can be supplied.',
      'component=controller_service_group restarts only this Controller host service group (Controller, local Worker, OAuth sidecar); component=worker restarts only the specified connected Remote Worker. Other programs are never eligible.',
      'Allowed environment IDs come from ccm.config.json restart_allowlist and are checked at each call. The existing Supervisor must be running. A Worker restart is asynchronous: use list_projects to confirm the environment returns with state=normal and a new connected_at value compared with before restart. Acceptance is not recovery. Controller service-group restarts require separate Controller/OAuth/Worker health verification.',
      'Call directly. It does not grant any exec_command approval or persistent shell-command prefix.',
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
