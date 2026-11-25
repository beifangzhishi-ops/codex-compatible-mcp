import * as z from 'zod/v4';
import { APPROVAL_UI_URI } from '../ui/approval-app.mjs';
import { VERIFICATION_INPUT_UI_URI } from '../ui/verification-input-app.mjs';

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
  operation: z.literal('select_workspace').optional(),
  state: z.enum([
    'pending',
    'approved',
    'denied',
    'dispatching',
    'approved_retryable',
    'review_failed',
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
  workspace_registered: z.boolean().optional(),
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
  permission_hint: z.string().optional(),
  action_failed: z.boolean().optional(),
  review_source: z.literal('guardian').optional(),
  review_outcome: z.enum(['allow', 'deny', 'error']).optional(),
  review_retryable: z.boolean().optional(),
  review_risk_level: z.enum(['low', 'medium', 'high', 'critical']).optional(),
};

function jsonResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function adminRetryHint(value) {
  if (value.exit_code === undefined || value.exit_code === 0 ||
      value.approval_required || value.administrator_agent || value.run_as_admin) return null;
  const output = value.output || '';
  const protectedAdminPipe = output.toLowerCase().includes(
    '\\pipe\\protectedprefix\\administrators\\',
  );
  const explicitElevationError =
    /\b(?:ERROR_ELEVATION_REQUIRED|the requested operation requires elevation|a required privilege is not held by the client|this (?:command|operation) requires administrator privileges)\b/i.test(output);
  if (!protectedAdminPipe && !explicitElevationError) return null;
  return 'Possible Windows administrator-token requirement. If the task authorizes this operation, consider retrying exec_command with run_as_admin=true (one-shot Guardian/human approval). This is distinct from sandbox_permissions=require_escalated; generic access, network or path errors are not sufficient evidence.';
}

function execResult(value) {
  const hint = adminRetryHint(value);
  const result = hint ? { ...value, permission_hint: hint } : value;
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
      'Call request_approval with this approval_id. CCM executes the action directly after approval.',
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
  if (hint) lines.push('Permission hint: ' + hint);
  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    structuredContent: result,
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
    'CCM executes the action directly after approval.',
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
    name: 'list_workers',
    provider: 'ccm-core',
    tags: ['environment', 'worker', 'capabilities'],
    supportsParallel: true,
    description: 'List connected Workers, platform, capabilities, sandbox_read_scope and sandbox_write_scope, and connection state. Compare connected_at and state=normal after restart. Project management is performed by the owner in the CCM management webpage.',
    inputSchema: { environment_id: z.string().optional() },
    handler: async (args) => {
      try {
        if (args.environment_id) runtime.environmentRegistry.resolve(args.environment_id);
        const environments = runtime.environmentRegistry.listPublic()
          .filter(env => !args.environment_id || env.id === args.environment_id)
          .map(env => ({ ...env, ...(runtime.workerHub.environmentStatus?.(env.id) || { state: 'normal' }) }));
        return jsonResult({ default_environment_id: runtime.environmentRegistry.defaultEnvironmentId, environments });
      } catch (error) { return toolError(error); }
    },
  });

  registry.register({
    name: 'exec_command',
    provider: 'ccm-core',

    tags: ['shell', 'process', 'terminal', 'command'],
    environmentRequirements: { capabilities: ['exec'] },
    supportsParallel: true,
    description: [
      "Run shell command with pipes (tty=true for PTY); returns output/session_id. Reuse workspace_handle for routing/cwd and session ownership; omitted handles auto-create a projectless context on primary Worker (or environment_id) and return it. Its read scope follows the Worker, while ordinary writes follow the workspace sandbox.",
      "When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)",
      "Start all resident/long-running processes in the background without visible console windows. On Windows, use a no-console process launch mode, not merely a hidden parent terminal. Keep supervision and logs.",
      "Native Codex ExecPolicy .rules decides Allow (Full Access), Prompt (approval), Forbidden (deny); unmatched commands remain sandboxed. Trusted package scripts are workspace/script-hash bound.",
      "For escalation use sandbox_permissions=require_escalated, justification and review_context. Guardian errors return state=review_failed, approval_required=false without dispatch: retry once if review_retryable=true; if it fails again, tell the user to continue when automatic approval responds. Never show a human card for review failures or retry a Guardian denial. If approval_required=true, call request_approval (Guardian disabled).",
      "For repeatable build/test/dev escalation, proactively supply a practical prefix_rule with fixed executable, subcommand, script and options, omitting variable suffixes or generic shells. Always allow saves it across Workers; omit prefix_rule on ordinary commands.",
      "Timed Full Access: use the full_access_grant_id supplied by the owner from the CCM management webpage per command. If needed, ask the owner for the ID. No grant changes Worker baseline or renews expiry.",
      "Windows run_as_admin=true uses an unrestricted administrator Agent after one-shot Guardian approval (or human approval if Guardian is disabled). It cannot combine with escalation, grants or prefix_rule; saved rules cannot authorize admin. Preserve verified absolute targets for destructive file operations.",
      "After a completed Windows command fails with clear administrator-token evidence (e.g., a ProtectedPrefix\\Administrators pipe), proactively consider run_as_admin=true if authorized. Distinguish generic Access is denied, sandbox, path and network errors; never automatically elevate. The retry needs separate one-shot approval.",
      "Host Script/tool failure without a structured CCM result proves neither dispatch nor rejection. Distinguish process exit and network/Worker errors; do not silently start a replacement session.",
    ].join('\n\n'),
    inputSchema: {
      cmd: z.string().min(1).describe('Shell command to execute.'),
      workspace_handle: z.string().uuid().optional().describe('Existing workspace execution handle (UUID). If user/project instructions supply one for the intended workspace, reuse it directly. If omitted, CCM creates a projectless workspace, not a registered-project entry.'),
      environment_id: z.string().optional().describe('Worker for automatic projectless creation without a handle; defaults to primary. Do not combine with workspace_handle.'),
      workdir: z.string().optional().describe('Relative subdirectory inside the selected context root. Defaults to the context root.'),
      tty: z.boolean().optional().describe('True allocates a PTY; false or omitted uses plain pipes.'),
      yield_time_ms: z.number().int().max(30_000).nonnegative().optional().describe('Wait before the initial command call yields output or a session. Defaults to 2000 ms. Values above 5000 ms are clamped to 5000 ms; long-running commands continue in a session and should be resumed with write_stdin.'),
      max_output_tokens: z.number().int().positive().optional().describe('Output token budget. Defaults to 10000 tokens.'),
      shell: z.string().optional().describe("Shell binary to launch. Defaults to the environment's default shell."),
      sandbox_permissions: z.enum(['use_default', 'require_escalated']).optional().describe('Set require_escalated when this command genuinely needs full-access outside the normal sandbox.'),
      run_as_admin: z.boolean().optional().describe('Request one-time Guardian approval (human only if Guardian is disabled) before using the local Windows administrator agent with unrestricted administrator OS permissions. Never covered by saved Allow rules or Full Access grants; incompatible with escalation/grant/prefix_rule.'),
      prefix_rule: z.array(z.string().min(1).max(4096)).min(1).max(64).optional().describe('For a repeatable command requiring Full Access, propose a stable, narrowly useful ordered-token prefix for global Always allow; e.g. ["npm","run","build:native"]. Include stable script paths/options, omit variable suffixes, and never propose a bare generic shell/interpreter. Valid only with require_escalated and must match at least one executable segment.'),
      justification: z.string().optional().describe('User-facing explanation for a require_escalated or run_as_admin approval request.'),
      review_context: z.string().max(8192).optional().describe('Main model summary of actual user task, authorized effects, and constraints for Guardian review of this command, including administrator requests.'),
      full_access_grant_id: z.string().uuid().optional().describe('Active CCM global web Full Access grant. If supplied and valid, this command runs with Full Access without individual approval across any Worker.'),
    },
    outputSchema: UNIFIED_EXEC_OUTPUT_SCHEMA,
    handler: async (args) => {
      try {
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
      'CCM executes the action directly after approval.',
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
      'On approve, CCM resumes only the previously frozen execution. approve_always saves a global token-prefix Allow rule for execution approvals. This tool accepts no command, workspace target, workdir, or shell override.',
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
        const resolved = await runtime.processManager.resolvePendingExecution(args, { hostSession });
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
      'Apply a Codex-style Begin/End Patch. Reuse an existing workspace_handle; if omitted, CCM creates a projectless handle on the primary Worker (or environment_id).',
      'For timed Full Access, pass the full_access_grant_id supplied by the owner from the CCM management webpage. If needed, ask the owner for the ID. Otherwise the original Worker write boundary remains in force.',
      'Automatic projectless creation never enters a registered project. For registered-project edits, supply its handle; ask the owner for the handle if missing.',
    ].join('\n\n'),
    inputSchema: {
      patch: z.string().min(1).describe('Codex-style patch text beginning with *** Begin Patch.'),
      workspace_handle: z.string().uuid().optional().describe('Existing workspace handle; omit to create a projectless handle.'),
      environment_id: z.string().optional().describe('Worker for automatic projectless creation without a handle. Do not combine with workspace_handle.'),
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
      'Reuse an existing workspace_handle; if omitted, CCM creates a projectless handle on the primary Worker (or environment_id). Use a supplied registered-project handle for project access.',
      'For multiple images, the Host may call this tool repeatedly.',
    ].join(' '),
    inputSchema: {
      path: z.string().min(1).describe('Absolute or context-relative local image path, within the Worker read scope.'),
      workspace_handle: z.string().uuid().optional().describe('Existing workspace handle; omit to create a projectless handle.'),
      environment_id: z.string().optional().describe('Worker for automatic projectless creation without a handle. Do not combine with workspace_handle.'),
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
