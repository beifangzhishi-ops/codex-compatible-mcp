import * as z from 'zod/v4';
import { APPROVAL_UI_URI } from '../ui/approval-app.mjs';
import { VERIFICATION_INPUT_UI_URI } from '../ui/verification-input-app.mjs';
import { readProjectDirectoryHints } from '../runtime/ccm-config.mjs';

const UNIFIED_EXEC_OUTPUT_SCHEMA = {
  chunk_id: z.string().optional(),
  wall_time_seconds: z.number(),
  exit_code: z.number().int().optional(),
  session_id: z.number().int().optional(),
  original_token_count: z.number().int().optional(),
  output: z.string(),
  approval_required: z.boolean().optional(),
  approval_id: z.string().optional(),
  operation_id: z.string().optional(),
  kind: z.enum(['execution', 'workspace']).optional(),
  operation: z.enum(['select_workspace', 'register_workspace', 'unregister_workspace']).optional(),
  state: z.enum([
    'pending',
    'approved',
    'denied',
    'dispatching',
    'approved_retryable',
    'execution_unknown',
    'consumed',
  ]).optional(),
  environment_id: z.string().optional(),
  command: z.string().optional(),
  workdir: z.string().nullable().optional(),
  tty: z.boolean().optional(),
  shell: z.string().nullable().optional(),
  justification: z.string().optional(),
  expires_at: z.string().optional(),
  intent_sha256: z.string().optional(),
  workspace_handle: z.string().optional(),
  workspace_id: z.string().optional(),
  workspace_kind: z.enum(['registered', 'projectless']).optional(),
  workspace_root: z.string().optional(),
  workspace_created_at: z.string().optional(),
  create_if_missing: z.boolean().optional(),
  created_at: z.string().optional(),
  policy_auto_approved: z.boolean().optional(),
  policy_saved: z.boolean().optional(),
  policy_rule_id: z.string().optional(),
  policy_rule_ids: z.array(z.string()).optional(),
  policy_prefix_tokens: z.union([
    z.array(z.string()),
    z.array(z.array(z.string())),
  ]).optional(),
  policy_persistable: z.boolean().optional(),
  policy_kind: z.enum(['prefix']).nullable().optional(),
  prefix_rule: z.array(z.string()).nullable().optional(),
  policy_save_failed: z.boolean().optional(),
  policy_save_error: z.string().optional(),
  trusted_package_script: z.boolean().optional(),
  trusted_package_script_rule_id: z.string().optional(),
  administrator_agent: z.boolean().optional(),
  run_as_admin: z.boolean().optional(),
  action_failed: z.boolean().optional(),
  review_source: z.literal('guardian').optional(),
  review_outcome: z.enum(['allow', 'deny', 'error']).optional(),
  review_risk_level: z.enum(['low', 'medium', 'high', 'critical']).optional(),
};

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function execResult(value) {
  const lines = [];
  if (value.approval_required) {
    lines.push('Approval required: yes');
    lines.push('Approval ID: ' + value.approval_id);
    lines.push('Environment: ' + value.environment_id);
    lines.push('Command: ' + value.command);
    lines.push(value.run_as_admin
      ? 'Permission: unrestricted Windows administrator for this execution only'
      : 'Permission: full-access for this execution only');
    if (value.policy_persistable && Array.isArray(value.prefix_rule)) {
      lines.push('Persistent prefix: ' + value.prefix_rule.join(' '));
    }
    lines.push('Expires: ' + value.expires_at);
    lines.push('Justification: ' + value.justification);
    lines.push(
      'Call the top-level request_approval tool with this approval_id to render the CCM approval card. ' +
      'Do not recreate or retry the command yourself.',
    );
  }
  if (value.chunk_id) lines.push(`Chunk ID: ${value.chunk_id}`);
  if (value.workspace_handle) {
    lines.push(`Workspace handle: ${value.workspace_handle}`);
    lines.push(`Workspace: ${value.environment_id} / ${value.workspace_id}`);
    lines.push(`Workspace kind: ${value.workspace_kind}`);
  }
  lines.push(`Wall time: ${value.wall_time_seconds.toFixed(4)} seconds`);
  if (value.exit_code !== undefined) lines.push(`Process exited with code ${value.exit_code}`);
  if (value.session_id !== undefined) lines.push(`Process running with session ID ${value.session_id}`);
  if (value.original_token_count !== undefined) lines.push(`Original token count: ${value.original_token_count}`);
  if (value.administrator_agent) lines.push('Execution: unrestricted Windows administrator agent');
  if (value.review_source === 'guardian') {
    lines.push('Guardian review: ' + value.review_outcome);
  }
  lines.push('Output:');
  if (value.output) lines.push(value.output);
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: value,
  };
}

function approvalCardResult(prepared) {
  const value = prepared.value;
  if (prepared.autoApproved) {
    const trustedPackageScript = Boolean(value.trusted_package_script);
    return {
      content: [{
        type: 'text',
        text: [
          trustedPackageScript
            ? 'CCM executed this command through a trusted package-script rule.'
            : 'CCM executed this full-access command under a saved global Allow rule.',
          'Environment: ' + value.environment_id,
          'Workspace: ' + value.workspace_id,
          'Command: ' + value.command,
          (trustedPackageScript ? 'Trust rule: ' : 'Policy rule: ') +
            (trustedPackageScript
              ? value.trusted_package_script_rule_id
              : value.policy_rule_id),
          'No additional user approval was required.',
        ].join('\n'),
      }],
      structuredContent: value,
      _meta: {
        source: trustedPackageScript
          ? 'ccm.trusted-package-script'
          : 'ccm.exec-policy',
      },
    };
  }
  const workspaceAction = value.kind === 'workspace';
  const lines = [
    workspaceAction
      ? 'CCM prepared a frozen workspace action for user approval.'
      : 'CCM prepared a frozen full-access command for user approval.',
    'Approval ID: ' + value.approval_id,
    'Operation ID: ' + value.operation_id,
    'Environment: ' + value.environment_id,
    'Workspace: ' + value.workspace_id,
    ...(workspaceAction
      ? [
          'Workspace root: ' + value.workspace_root,
          'Action: ' + value.operation,
        ]
      : ['Command: ' + value.command]),
    'Expires: ' + value.expires_at,
    'The attached CCM approval card is the only valid approval path for this request.',
    workspaceAction
      ? 'Do not recreate or retry this workspace action yourself.'
      : 'Do not recreate or retry this command yourself.',
  ];
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: value,
    _meta: {
      source: 'ccm.approval',
      approval_nonce: prepared.approvalNonce,
    },
  };
}

function workspaceActionStatus(request, {
  output,
  workspaceHandle = null,
  actionFailed = false,
} = {}) {
  return {
    wall_time_seconds: 0,
    output: String(output || ''),
    ...request,
    ...(workspaceHandle || {}),
    ...(actionFailed ? { action_failed: true } : {}),
  };
}

async function executeWorkspaceAction(runtime, action, {
  requireFullAccess = false,
} = {}) {
  const environment = runtime.environmentRegistry.resolve(
    action.environment_id,
  );
  const timedFullAccess = runtime.webFullAccess?.authorize(action.full_access_grant_id) || false;
  if (requireFullAccess && environment.permissionProfile !== 'full-access' && !timedFullAccess) {
    throw new Error(
      'Environment is no longer full-access; retry the workspace action.',
    );
  }
  let workspace;
  if (action.operation === 'unregister_workspace') {
    const current = await runtime.workerHub.call(
      environment.id,
      'get_registered_workspace',
      { workspace_id: action.workspace_id },
      { timeoutMs: 10_000 },
    );
    if (current.kind !== 'registered' ||
        current.workspace_id !== action.workspace_id ||
        current.root !== action.workspace_root ||
        current.created_at !== action.workspace_created_at) {
      throw new Error('Workspace registration changed since approval was requested.');
    }
    // Revoke Controller context handles before changing the Worker registry.
    // A failed Controller state write must not leave an unrevoked old context.
    runtime.workspaceHandleManager.revokeRegistered(
      environment.id, action.workspace_id,
    );
    await runtime.workerHub.call(
      environment.id,
      'unregister_workspace',
      {
        workspace_id: action.workspace_id,
        expected_root: action.workspace_root,
        expected_created_at: action.workspace_created_at,
      },
      { timeoutMs: 10_000 },
    );
    return null;
  }
  if (action.operation === 'select_workspace') {
    workspace = await runtime.workerHub.call(
      environment.id,
      'get_workspace',
      { workspace_id: action.workspace_id },
      { timeoutMs: 10_000 },
    );
    if (workspace.kind !== 'registered' ||
        workspace.workspace_id !== action.workspace_id ||
        workspace.root !== action.workspace_root) {
      throw new Error(
        'Workspace identity no longer matches the registered workspace.',
      );
    }
  } else if (action.operation === 'register_workspace') {
    const inspected = await runtime.workerHub.call(
      environment.id,
      'inspect_workspace_path',
      {
        path: action.workspace_root,
        workspace_id: action.workspace_id,
        create_if_missing: Boolean(action.create_if_missing),
      },
      { timeoutMs: 10_000 },
    );
    if (inspected.workspace_id !== action.workspace_id ||
        inspected.root !== action.workspace_root) {
      throw new Error(
        'Workspace registration target no longer matches the inspected path.',
      );
    }
    workspace = await runtime.workerHub.call(
      environment.id,
      'register_workspace',
      {
        path: action.workspace_root,
        workspace_id: action.workspace_id,
        create_if_missing: Boolean(action.create_if_missing),
        approved_root: action.workspace_root,
      },
      { timeoutMs: 10_000 },
    );
    if (workspace.workspace_id !== action.workspace_id ||
        workspace.root !== action.workspace_root) {
      throw new Error(
        'Registered workspace no longer matches the requested target.',
      );
    }
  } else {
    throw new Error('Unknown workspace operation: ' + action.operation);
  }

  return runtime.workspaceHandleManager.createRegistered(
    environment.id,
    workspace,
  );
}

async function resolvePendingWorkspaceAction(
  runtime,
  { approval_id: approvalId, approval_nonce: approvalNonce, decision },
  { hostSession = null } = {},
) {
  if (decision === 'approve_always') {
    throw new Error(
      'Always allow is only available for execution approvals.',
    );
  }
  if (decision === 'deny') {
    const denied = runtime.approvalManager.denyAppWorkspace(
      approvalId,
      approvalNonce,
      hostSession,
    );
    return workspaceActionStatus(denied, {
      output: 'The user denied this workspace action. No workspace change was made.',
    });
  }
  if (decision !== 'approve') {
    throw new Error('Workspace approval decision must be approve or deny.');
  }

  const claimed = runtime.approvalManager.claimAppWorkspace(
    approvalId,
    approvalNonce,
    hostSession,
  );
  const action = claimed.action;
  try {
    const workspaceHandle = await executeWorkspaceAction(runtime, action);
    const consumed = runtime.approvalManager.markAppWorkspaceConsumed(
      approvalId,
    );
    return workspaceActionStatus(consumed, {
      workspaceHandle,
      output: action.operation === 'unregister_workspace'
        ? 'Approved and unregistered the workspace. Project files were not deleted; previous workspace handles are invalid.'
        : action.operation === 'select_workspace'
          ? 'Approved and entered the selected workspace.'
          : 'Approved, registered, and entered the workspace.',
    });
  } catch (error) {
    let consumed = claimed.request;
    try {
      consumed = runtime.approvalManager.markAppWorkspaceConsumed(approvalId);
    } catch {}
    return workspaceActionStatus(consumed, {
      output:
        'Workspace action was not performed: ' +
        String(error?.message || error),
      actionFailed: true,
    });
  }
}

function patchResult(value) {
  return {
    content: [{ type: 'text', text: value.output }],
    structuredContent: {
      workdir: value.workdir,
      changes: value.changes,
      ...(value.workspace_handle ? {
        workspace_handle: value.workspace_handle,
        environment_id: value.environment_id,
        workspace_id: value.workspace_id,
        workspace_kind: value.workspace_kind,
        workspace_root: value.workspace_root,
      } : {}),
    },
  };
}

function imageResult(value) {
  return {
    content: [{
      type: 'image',
      data: value.data,
      mimeType: value.mime_type,
    }],
    _meta: {
      path: value.path,
      mime_type: value.mime_type,
      width: value.width,
      height: value.height,
      byte_length: value.byte_length,
      source_byte_length: value.source_byte_length,
      source_width: value.source_width,
      source_height: value.source_height,
      compressed: value.compressed,
      ...(value.workspace_handle ? {
        workspace_handle: value.workspace_handle,
        environment_id: value.environment_id,
        workspace_id: value.workspace_id,
        workspace_kind: value.workspace_kind,
        workspace_root: value.workspace_root,
      } : {}),
    },
  };
}

function toolError(error) {
  return {
    content: [{ type: 'text', text: String(error?.message || error) }],
    isError: true,
  };
}

export function registerCoreTools(registry, runtime) {
  registry.register({
    name: 'claim_full_access',
    provider: 'ccm-core',

    tags: ['approval', 'full-access', 'unlock'],
    description: 'Fallback only when the owner unlocked CCM at /ccm/unlock but has not provided a usable full_access_grant_id (for example, ChatGPT blocked the copied message). Claim the pending web grant, or recover the SAME already-claimed ID once after browser copy, within the original five-minute claim window or earlier grant expiry. No arguments. Do not call if the user supplied an already-claimed ID. Use the returned full_access_grant_id explicitly in privileged tools; claiming or recovery never extends expiry or changes Worker configuration. Never request or expose phone enrollment secrets.',
    inputSchema: {},
    handler: async () => {
      const claim = runtime.webFullAccess?.claim();
      return jsonResult(claim || {
        claimed: false,
        message: 'No unused fallback claim is available. The owner can copy the active grant ID from the CCM unlock webpage or unlock again after expiry.',
      });
    },
  });
  registry.register({
    name: 'request_verification_input',
    provider: 'ccm-core',

    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    mcpMeta: {
      ui: { resourceUri: VERIFICATION_INPUT_UI_URI, visibility: ['model', 'app'] },
      'ui/resourceUri': VERIFICATION_INPUT_UI_URI,
      'openai/outputTemplate': VERIFICATION_INPUT_UI_URI,
      'openai/widgetAccessible': true,
    },
    tags: ['verification', 'input', 'ui', 'session'],
    description: [
      "Show a verification card only for a live process waiting for a code; pass its workspace_handle and session_id. Never ask for the code in chat or put it in exec_command/write_stdin.",
      "The App submits the code directly. Wait for its automatic code-free follow-up; on that follow-up, assume the code has been submitted and continue the task. Do NOT inspect or request the code, check card/status, or poll specifically to verify entry. Show another card only after an explicit invalid-code result from ordinary task execution.",
    ].join('\n\n'),
    inputSchema: {
      workspace_handle: z.string().uuid().describe('Workspace handle that owns the live session.'),
      session_id: z.number().int().describe('Live public session_id returned by exec_command.'),
      label: z.string().min(1).max(100).optional().describe('Short purpose displayed above the code field. Defaults to Verification code.'),
    },
    handler: async (args, context) => {
      try {
        const prepared = runtime.verificationInputManager.create({
          workspaceHandle: args.workspace_handle,
          sessionId: args.session_id,
          label: args.label,
          hostSession: context?.extra?._meta?.['openai/session'] || null,
        });
        return {
          content: [{ type: 'text', text:
            'CCM verification input card is ready for the live process session. ' +
            'The user submits directly in the card; do not request or transmit the code in model tool arguments. ' +
            'Wait for the card\'s automatic code-free continuation after the user clicks Submit. ' +
            'Then assume verification input was submitted and continue the original task without checking the code or its submission status. ' +
            'If ordinary task execution later reports an invalid code, request another card for the live session.' }],
          structuredContent: prepared,
        };
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'get_verification_input_status',
    provider: 'ccm-core',

    mcpMeta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    tags: ['verification', 'status', 'app-only'],
    description: 'App-only read of a CCM verification-input card state; never returns input content.',
    inputSchema: { request_id: z.string().uuid() },
    handler: async (args, context) => {
      try {
        return jsonResult(runtime.verificationInputManager.status(args.request_id, {
          hostSession: context?.extra?._meta?.['openai/session'] || null,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'submit_verification_input',
    provider: 'ccm-core',

    mcpMeta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    tags: ['verification', 'input', 'app-only'],
    description: 'App-only delivery of verification input to the live process session bound to the card. The response never contains the value or process stdout.',
    inputSchema: {
      request_id: z.string().uuid(),
      value: z.string().min(1).max(256),
    },
    handler: async (args, context) => {
      try {
        return jsonResult(await runtime.verificationInputManager.submit(
          args.request_id, args.value, {
            hostSession: context?.extra?._meta?.['openai/session'] || null,
          },
        ));
      } catch {
        return toolError(new Error('CCM verification input could not be delivered.'));
      }
    },
  });

  registry.register({
    name: 'list_projects',
    provider: 'ccm-core',

    tags: ['project', 'environment', 'worker', 'capabilities'],
    supportsParallel: true,
    description: [
      "List connected Workers, registered projects and configured default project directories without entering a workspace. Omit environment_id for all Workers; all=true also lists existing projectless workspaces.",
      "Results include independent sandbox_read_scope and sandbox_write_scope, platform, capabilities and Worker state. A project_directory_hint is for display only, never workspace-entry authorization or an authoritative project root. Compare connected_at and state=normal after restart; one stale Worker or a single network timeout does not prove all Workers are offline.",
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().optional().describe('Optional environment id. Omit to list projects across every connected environment.'),
      all: z.boolean().optional().describe('Include existing projectless workspaces in a separate projectless_workspaces collection. Defaults to false.'),
    },
    handler: async (args) => {
      try {
        const directoryHints = readProjectDirectoryHints(runtime.ccmConfigFile);
        const publicEnvironments = runtime.environmentRegistry.listPublic();
        let environments = publicEnvironments;
        if (args.environment_id) {
          runtime.environmentRegistry.resolve(args.environment_id);
          environments = publicEnvironments.filter(
            (environment) => environment.id === args.environment_id,
          );
        }
        const includeAll = Boolean(args.all);
        const discover = async (environment) => {
          const directoryHint = Object.hasOwn(directoryHints, environment.id)
            ? directoryHints[environment.id] : undefined;
          const withDirectoryHint = (result) => ({
            ...result,
            ...(directoryHint === undefined ? {} : { project_directory_hint: directoryHint }),
          });
          const currentStatus = runtime.workerHub.environmentStatus?.(
            environment.id,
          ) || { state: 'normal' };
          if (currentStatus.state === 'abnormal') {
            const error = new Error(
              currentStatus.abnormal_reason ||
              'Remote Worker is quarantined.',
            );
            error.code = 'worker_quarantined';
            if (args.environment_id) throw error;
            return withDirectoryHint({ ...environment, ...currentStatus });
          }

          try {
            const result = await runtime.workerHub.call(
              environment.id,
              'list_projects',
              { all: includeAll },
              { timeoutMs: 10_000 },
            );
            return withDirectoryHint({
              ...environment,
              state: 'normal',
              ...(currentStatus.connected_at ? { connected_at: currentStatus.connected_at } : {}),
              projects: result.projects || [],
              ...(includeAll
                ? { projectless_workspaces: result.projectless_workspaces || [] }
                : {}),
            });
          } catch (error) {
            runtime.workerHub.quarantine?.(
              environment.id,
              error?.code || 'project_discovery_failed',
              String(error?.message || error),
            );
            if (args.environment_id) throw error;
            const failedStatus = runtime.workerHub.environmentStatus?.(
              environment.id,
            ) || {
              state: 'abnormal',
              abnormal_code: error?.code || 'project_discovery_failed',
              abnormal_reason: String(error?.message || error),
            };
            return withDirectoryHint({
              ...environment,
              ...failedStatus,
              project_discovery_error: String(error?.message || error),
            });
          }
        };
        const enriched = await Promise.all(environments.map(discover));
        return jsonResult({
          default_environment_id: runtime.environmentRegistry.defaultEnvironmentId,
          environments: enriched,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'create_projectless_handle',
    provider: 'ccm-core',

    tags: ['workspace', 'projectless', 'context', 'environment'],
    supportsParallel: true,
    description: [
      'Create a projectless workspace_handle for operations that do not belong to a registered project.',
      'Use when no suitable handle exists for genuinely projectless work or permitted absolute-path reads. Never use it to bypass a pending explicit workspace-entry approval or to write into a registered project. If environment_id is omitted, CCM uses the primary environment.',
      'The returned workspace_handle supplies Worker routing and the context root for subsequent CCM operations. Read-scope decisions, including whether absolute paths outside the projectless root are readable, belong to list_projects and exec_command rather than this lifecycle tool.',
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().optional().describe('Environment on which to create the projectless workspace. Omit to use the primary environment.'),
    },
    handler: async (args) => {
      try {
        if (!runtime.workspaceHandleManager) {
          throw new Error('Workspace handle manager is not available.');
        }
        return jsonResult(
          await runtime.workspaceHandleManager.createProjectless(args.environment_id),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'select_workspace',
    provider: 'ccm-core',

    tags: ['workspace', 'project', 'approval'],
    description: [
      "Enter an existing registered workspace only when the user explicitly requested entry/switch AND there is no usable workspace_handle. Merely inspecting or editing a project is not entry authorization.",
      "Full Access returns the handle; otherwise if approval_required=true call request_approval and use the completed card. Never expose a pending/failed handle, retry the frozen entry, or bypass it with projectless work.",
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().describe('Environment whose Worker owns the workspace.'),
      workspace_id: z.string().min(1).describe('Registered workspace id on that Worker.'),
      full_access_grant_id: z.string().uuid().optional().describe('Optional active CCM web Full Access grant ID, valid for any Worker until expiry.'),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        const workspace = await runtime.workerHub.call(
          environment.id,
          'get_workspace',
          { workspace_id: args.workspace_id },
          { timeoutMs: 10_000 },
        );
        if (workspace.kind !== 'registered') {
          throw new Error('select_workspace only accepts registered workspaces.');
        }
        const intent = {
          environment_id: environment.id,
          workspace_id: workspace.workspace_id,
          workspace_root: workspace.root,
        };
        const timedFullAccess = runtime.webFullAccess?.authorize(args.full_access_grant_id) || false;
        if (environment.permissionProfile === 'full-access' || timedFullAccess) {
          return jsonResult(await executeWorkspaceAction(runtime, {
            operation: 'select_workspace',
            ...intent,
            full_access_grant_id: args.full_access_grant_id,
          }, { requireFullAccess: true }));
        }
        const justification =
          'Allow CCM to enter registered workspace ' +
          environment.id + ' / ' + workspace.workspace_id +
          ' at ' + workspace.root + '?';
        const approval = runtime.approvalManager.requestWorkspaceAction(
          'select_workspace',
          intent,
          justification,
        );
        return jsonResult({
          approval_required: true,
          ...approval,
          instruction:
            'Call the top-level request_approval tool with this approval_id. ' +
            'While this workspace remains the user\'s intended target, wait for this frozen action to resolve; ' +
            'do not retry the same target or create or switch to projectless workspace to bypass it. ' +
            'Changing projects alone does not authorize new entry; request a handle or an explicit entry/registration instruction. ' +
            'A separately authorized new workspace action does not require denying this older pending approval.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'register_workspace',
    provider: 'ccm-core',

    tags: ['workspace', 'project', 'approval', 'register'],
    description: [
      "Register and enter an exact project directory only on explicit user registration request AND when no usable handle exists. create_if_missing may create that directory; inspecting or editing alone is not authorization.",
      "Full Access returns the handle; otherwise if approval_required=true call request_approval and use the completed card. Do not expose pending/failed handles, retry the frozen action, or bypass it through projectless work.",
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().describe('Environment whose Worker owns the directory.'),
      path: z.string().min(1).describe('Absolute project directory path on the selected Worker.'),
      workspace_id: z.string().min(1).optional().describe('Optional Worker-local workspace id. Defaults to a safe form of the directory name.'),
      create_if_missing: z.boolean().optional().describe('Create the target directory during registration if it is missing. Defaults to false.'),
      full_access_grant_id: z.string().uuid().optional().describe('Optional active CCM web Full Access grant ID.'),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        const inspected = await runtime.workerHub.call(
          environment.id,
          'inspect_workspace_path',
          {
            path: args.path,
            workspace_id: args.workspace_id,
            create_if_missing: Boolean(args.create_if_missing),
          },
          { timeoutMs: 10_000 },
        );
        const intent = {
          environment_id: environment.id,
          workspace_id: inspected.workspace_id,
          workspace_root: inspected.root,
          create_if_missing: Boolean(args.create_if_missing),
        };
        const timedFullAccess = runtime.webFullAccess?.authorize(args.full_access_grant_id) || false;
        if (environment.permissionProfile === 'full-access' || timedFullAccess) {
          return jsonResult(await executeWorkspaceAction(runtime, {
            operation: 'register_workspace',
            ...intent,
            full_access_grant_id: args.full_access_grant_id,
          }, { requireFullAccess: true }));
        }
        const action = inspected.create_required
          ? 'create, register, and enter workspace '
          : 'register and enter workspace ';
        const justification =
          'Allow CCM to ' + action +
          environment.id + ' / ' + inspected.workspace_id +
          ' at ' + inspected.root + '?';
        const approval = runtime.approvalManager.requestWorkspaceAction(
          'register_workspace',
          intent,
          justification,
        );
        return jsonResult({
          approval_required: true,
          ...approval,
          instruction:
            'Call the top-level request_approval tool with this approval_id. ' +
            'While this workspace remains the user\'s intended target, wait for this frozen action to resolve; ' +
            'do not retry the same target or create or switch to projectless workspace to bypass it. ' +
            'Changing projects alone does not authorize new entry; request a handle or an explicit entry/registration instruction. ' +
            'A separately authorized new workspace action does not require denying this older pending approval.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'unregister_workspace',
    provider: 'ccm-core',

    tags: ['workspace', 'project', 'approval', 'unregister'],
    description: [
      "Unregister one registered workspace without deleting its files. Always requires a one-shot CCM approval card, including on Full Access; call request_approval if approval_required=true.",
      "Approval revokes its existing handles but does not kill running processes. Projectless workspaces cannot be unregistered.",
    ].join('\n\n'),
    inputSchema: {
      environment_id: z.string().describe('Environment whose Worker owns the workspace.'),
      workspace_id: z.string().min(1).describe('Exact registered workspace id on that Worker.'),
    },
    handler: async (args) => {
      try {
        const environment = runtime.environmentRegistry.resolve(args.environment_id);
        const workspace = await runtime.workerHub.call(
          environment.id,
          'get_registered_workspace',
          { workspace_id: args.workspace_id },
          { timeoutMs: 10_000 },
        );
        if (workspace.kind !== 'registered') {
          throw new Error('unregister_workspace only accepts registered workspaces.');
        }
        const approval = runtime.approvalManager.requestWorkspaceAction(
          'unregister_workspace',
          {
            environment_id: environment.id,
            workspace_id: workspace.workspace_id,
            workspace_root: workspace.root,
            workspace_created_at: workspace.created_at,
          },
          'Allow CCM to unregister workspace ' + environment.id + ' / ' +
          workspace.workspace_id + ' at ' + workspace.root +
          '? The project directory and files will remain. Previously issued workspace handles will be invalidated.',
        );
        return jsonResult({
          approval_required: true,
          ...approval,
          instruction: 'Call the top-level request_approval tool with this approval_id. Do not retry or bypass this frozen unregister action.',
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'exec_command',
    provider: 'ccm-core',

    tags: ['shell', 'process', 'terminal', 'command'],
    environmentRequirements: { capabilities: ['exec'] },
    supportsParallel: true,
    description: [
      "Run a shell command using pipes (tty=true for PTY); return output or a session_id for write_stdin. Reuse workspace_handle for routing/cwd and session ownership; its read scope follows the Worker, while ordinary writes follow the workspace sandbox.",
      "Native Codex ExecPolicy .rules decides Allow (Full Access), Prompt (approval), Forbidden (deny); unmatched commands remain sandboxed. Trusted package scripts are workspace/script-hash bound.",
      "For a command requiring escalation, set sandbox_permissions=require_escalated, give justification and accurate review_context. When enabled, Guardian may allow one frozen execution, deny it, or fall back to a human approval card. If approval_required=true call request_approval, never reissue the action.",
      "For repeatable build/test/dev escalation, proactively supply a practical prefix_rule: stable executable, subcommand, script and fixed options, excluding variable suffixes. Do not use a bare generic shell/interpreter. Always allow saves the prefix across Workers; do not pass prefix_rule on ordinary commands.",
      "Timed Full Access: use the supplied claimed full_access_grant_id per command, or call claim_full_access only if the owner unlocked without providing the ID. No grant changes Worker baseline or renews expiry.",
      "Windows run_as_admin=true uses an unrestricted administrator Agent after one-shot Guardian/human approval. It cannot combine with escalation, grants or prefix_rule; saved rules cannot authorize admin. Preserve verified absolute targets for destructive file operations.",
      "Host Script/tool failures without a structured CCM result are not evidence that CCM rejected or dispatched a command. Distinguish these from process exit errors, network/target-site errors and Worker connectivity before retrying; do not silently start a replacement session.",
    ].join('\n\n'),
    inputSchema: {
      cmd: z.string().min(1).describe('Shell command to execute.'),
      workspace_handle: z.string().uuid().describe('Existing workspace execution handle (UUID). If user/project instructions supply one for the intended workspace, reuse it directly without selecting/registering the workspace again. This is not an environment_id or workspace_id. The handle selects the Worker and workspace root; it does not limit the environment filesystem read scope.'),
      workdir: z.string().optional().describe('Relative subdirectory inside the selected context root. Defaults to the context root.'),
      tty: z.boolean().optional().describe('True allocates a PTY; false or omitted uses plain pipes.'),
      yield_time_ms: z.number().int().max(30_000).nonnegative().optional().describe('Wait before the initial command call yields output or a session. Defaults to 2000 ms. Values above 5000 ms are clamped to 5000 ms; long-running commands continue in a session and should be resumed with write_stdin.'),
      max_output_tokens: z.number().int().positive().optional().describe('Output token budget. Defaults to 10000 tokens.'),
      shell: z.string().optional().describe("Shell binary to launch. Defaults to the environment's default shell."),
      sandbox_permissions: z.enum(['use_default', 'require_escalated']).optional().describe('Set require_escalated when this command genuinely needs full-access outside the normal sandbox.'),
      run_as_admin: z.boolean().optional().describe('Request one-time Guardian or human approval before using the local Windows administrator agent with unrestricted administrator OS permissions. Never covered by saved Allow rules or Full Access grants; incompatible with escalation/grant/prefix_rule.'),
      prefix_rule: z.array(z.string().min(1).max(4096)).min(1).max(64).optional().describe('For a repeatable command requiring Full Access, propose a stable, narrowly useful ordered-token prefix for global Always allow; e.g. ["npm","run","build:native"]. Include stable script paths/options, omit variable suffixes, and never propose a bare generic shell/interpreter. Valid only with require_escalated and must match at least one executable segment.'),
      justification: z.string().optional().describe('User-facing explanation for a require_escalated or run_as_admin approval request.'),
      review_context: z.string().max(8192).optional().describe('Main model summary of actual user task, authorized effects, and constraints for Guardian review of this command, including administrator requests.'),
      full_access_grant_id: z.string().uuid().optional().describe('Active CCM global web Full Access grant. If supplied and valid, this command runs with Full Access without individual approval across any Worker.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args) => {
      try {
        if (!args.workspace_handle) {
          throw new Error(
            'exec_command requires workspace_handle for Worker routing/cwd. Reuse the supplied handle; for projectless tasks or permitted absolute-path reads, use ccm.create_projectless_handle. Never select/register a project merely to read or work on it; ask for a handle or explicit entry instruction if registered-project writing requires one.',
          );
        }
        return execResult(await runtime.processManager.execCommand(args));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'request_approval',
    provider: 'ccm-core',

    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    mcpMeta: {
      ui: {
        resourceUri: APPROVAL_UI_URI,
        visibility: ['model', 'app'],
      },
      'ui/resourceUri': APPROVAL_UI_URI,
      'openai/outputTemplate': APPROVAL_UI_URI,
      'openai/widgetAccessible': true,
    },
    tags: ['approval', 'permission', 'ui'],
    description: [
      'Render the CCM approval card for one already-frozen pending action.',
      'Pass only the approval_id returned by a CCM business tool with approval_required=true. This tool does not accept or modify the command, workspace, path, or other frozen action fields.',
      'After the card is shown, the approval app handles the user decision through resolve_pending_action. Do not recreate or retry the original action.',
    ].join('\n\n'),
    inputSchema: {
      approval_id: z.string().uuid().describe('Opaque pending approval id returned by a CCM tool.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args, context) => {
      try {
        const hostSession = context?.extra?._meta?.['openai/session'] || null;
        const prepared = runtime.approvalManager.prepareAppApproval(
          args.approval_id,
          { hostSession },
        );
        return approvalCardResult({
          value: {
            wall_time_seconds: 0,
            output: 'Waiting for the user to approve or deny this frozen action.',
            approval_required: true,
            ...prepared.request,
          },
          approvalNonce: prepared.approvalNonce,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'get_approval_status',
    provider: 'ccm-core',

    mcpMeta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true },
    tags: ['approval', 'status', 'app-only'],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description: 'App-only authenticated read of a frozen CCM approval card state. Never dispatches an action.',
    inputSchema: {
      approval_id: z.string().uuid(),
      approval_nonce: z.string().min(20),
    },
    handler: async (args, context) => {
      try {
        const hostSession = context?.extra?._meta?.['openai/session'] || null;
        return jsonResult(runtime.approvalManager.readAppStatus(
          args.approval_id, args.approval_nonce, { hostSession },
        ));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'resolve_pending_action',
    provider: 'ccm-core',

    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    mcpMeta: {
      ui: { visibility: ['app'] },
      'openai/widgetAccessible': true,
    },
    tags: ['approval', 'sandbox', 'permission', 'app-only'],
    environmentRequirements: { capabilities: ['exec'] },
    description: [
      'App-only resolver for a frozen CCM approval request. It is invoked by the CCM approval card, not by the model.',
      'On approve, CCM resumes only the previously frozen execution or workspace action. approve_always saves a global token-prefix Allow rule only for execution approvals. This tool accepts no command, workspace target, workdir, or shell override.',
    ].join('\n\n'),
    inputSchema: {
      approval_id: z.string().uuid().describe('Frozen CCM approval identifier.'),
      approval_nonce: z.string().min(20).describe('One-time card secret delivered only through tool-result _meta.'),
      decision: z.enum(['approve', 'approve_always', 'deny']).describe('User decision from the CCM approval card.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args, context) => {
      try {
        const hostSession = context?.extra?._meta?.['openai/session'] || null;
        const pending = runtime.approvalManager.getRequest(args.approval_id);
        let resolved;
        if (pending.kind === 'workspace') {
          resolved = await resolvePendingWorkspaceAction(
            runtime,
            args,
            { hostSession },
          );
        } else {
          resolved = await runtime.processManager.resolvePendingExecution(
            args,
            { hostSession },
          );
        }
        try {
          runtime.approvalManager.recordAppOutcome(args.approval_id, resolved);
        } catch (receiptError) {
          // An already-executed one-shot action must not be reported as failed.
          runtime.audit?.({
            component: 'approval',
            event: 'receipt_persist_failed',
            approval_id: args.approval_id,
            error: String(receiptError?.message || receiptError),
          });
        }
        return execResult(resolved);
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'write_stdin',
    provider: 'ccm-core',

    tags: ['process', 'terminal', 'session', 'stdin'],
    description: [
      'Writes characters to an existing unified exec session and returns recent output.',
      'workspace_handle is required and must match the context that created session_id. Copy both values from the exec_command result; CCM rejects cross-workspace session continuation before contacting the Worker. Empty chars polls are read-only; a Host tool failure is not proof the process stopped or a poll succeeded.',
    ].join(' '),
    inputSchema: {
      session_id: z.number().int().describe('Identifier of the running unified exec session.'),
      workspace_handle: z.string().uuid().describe('Workspace handle returned with the exec_command session_id. It must own that session.'),
      chars: z.string().optional().describe('Bytes to write to stdin. Defaults to empty, which polls without writing.'),
      yield_time_ms: z.number().int().max(30_000).nonnegative().optional().describe('Non-empty writes default to 250 ms; empty polls default to 1000 ms. All write_stdin waits cap at 30000 ms.'),
      max_output_tokens: z.number().int().positive().optional().describe('Output token budget. Defaults to 10000 tokens.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args) => {
      try {
        return execResult(await runtime.processManager.writeStdin(args));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'apply_patch',
    provider: 'ccm-core',

    tags: ['edit', 'patch', 'filesystem'],
    environmentRequirements: { capabilities: ['applyPatch'] },
    description: [
      'Apply a Codex-style Begin/End Patch inside an existing workspace_handle.',
      'For timed Full Access, pass the full_access_grant_id supplied by the owner from the CCM unlock webpage, or returned by claim_full_access. Otherwise the original Worker write boundary remains in force.',
      'Reuse the existing workspace_handle. For genuinely projectless edits, use create_projectless_handle; for registered-project edits without a handle, request the handle or an explicit workspace-entry instruction. Never select/register implicitly or bypass pending approval.',
    ].join('\n\n'),
    inputSchema: {
      patch: z.string().min(1).describe('Codex-style patch text beginning with *** Begin Patch.'),
      workspace_handle: z.string().uuid().describe('Existing workspace handle.'),
      workdir: z.string().optional().describe('Relative subdirectory inside the selected context root.'),
      full_access_grant_id: z.string().uuid().optional().describe('Active CCM global web Full Access grant for patch permission.'),
    },
    handler: async (args) => {
      try {
        return patchResult(await runtime.fileService.applyPatch({
          ...args,
          workspace_scoped: true,
        }));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  registry.register({
    name: 'view_image',
    provider: 'ccm-core',

    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    tags: ['image', 'filesystem', 'media'],
    environmentRequirements: { capabilities: ['viewImage'] },
    supportsParallel: true,
    description: [
      'Read a local image and return bounded MCP image content. When the output byte budget is exceeded, the Worker first tries full-resolution low-loss WebP (quality 95/90/85), then progressively reduces dimensions if necessary to fit the budget. The source file is never modified. Source files are limited to 64 MiB.',
      'Reuse the existing workspace_handle. For genuinely projectless image reads, use create_projectless_handle; do not select/register a project merely to inspect images, or bypass a pending explicit entry approval.',
      'For multiple images, the Host may call this tool repeatedly.',
    ].join(' '),
    inputSchema: {
      path: z.string().min(1).describe('Image path relative to the selected context root.'),
      workspace_handle: z.string().uuid().describe('Existing workspace handle.'),
    },
    handler: async (args) => {
      try {
        return imageResult(await runtime.fileService.viewImage(args));
      } catch (error) {
        return toolError(error);
      }
    },
  });

  return registry;
}
