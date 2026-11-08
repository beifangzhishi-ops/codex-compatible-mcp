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
      'Allowed environment IDs come from ccm.config.json restart_allowlist and are checked at each call. The existing Supervisor must be running. Worker restart returns an operation_id; poll ccm.restart_status until recovered or failed. Acceptance is not recovery. Controller service-group restarts require separate health and reconnection verification; operation records do not survive Controller restart.',
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
  registry.register({
    name: 'restart_status',
    provider: 'ccm-core',
    supportsParallel: true,
    tags: ['restart', 'status'],
    description: 'Read one Worker restart operation without executing it again. recovered means the environment disconnected and registered a healthy connection afterward. failed includes recovery timeout. Records are bounded and lost on Controller restart; an unknown record never proves success. Also verify Controller/OAuth health as appropriate.',
    inputSchema: z.object({ operation_id: z.string().uuid() }).strict(),
    handler: async ({ operation_id }) => {
      try {
        const value = runtime.controlledRestart.status(operation_id);
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch (error) {
        return { content: [{ type: 'text', text: String(error.message) }], isError: true };
      }
    },
  });
}
