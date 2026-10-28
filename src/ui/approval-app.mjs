export const APPROVAL_UI_URI = 'ui://ccm/approval-v3.html';
export const PREVIOUS_APPROVAL_UI_URI = 'ui://ccm/approval-v2.html';
export const LEGACY_APPROVAL_UI_URI = 'ui://ccm/approval-v1.html';

export const APPROVAL_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: transparent;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", sans-serif;
    }
    body { padding: 2px; }
    #card {
      width: 100%;
      padding: 14px;
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      border-radius: 14px;
      background: color-mix(in srgb, Canvas 95%, currentColor 5%);
      color: CanvasText;
    }
    #title { font-size: 14px; font-weight: 700; line-height: 1.35; }
    #justification { margin-top: 5px; font-size: 13px; line-height: 1.4; }
    .row {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr);
      gap: 8px;
      margin-top: 8px;
      font-size: 12px;
      line-height: 1.35;
    }
    .label { opacity: 0.62; }
    .value { min-width: 0; overflow-wrap: anywhere; }
    #command {
      margin-top: 10px;
      padding: 9px 10px;
      border-radius: 10px;
      background: color-mix(in srgb, currentColor 7%, transparent);
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #status {
      margin-top: 10px;
      font-size: 12px;
      line-height: 1.4;
      opacity: 0.72;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #status[data-error="true"] { opacity: 1; }
    #handleRow { margin-top: 12px; }
    #handleElement {
      display: block; padding: 8px; margin-top: 5px;
      font: 12px/1.5 ui-monospace, Consolas, monospace;
      user-select: text; overflow-wrap: anywhere;
      border-radius: 7px;
      background: color-mix(in srgb, currentColor 7%, transparent);
    }
    #copyHandle { margin-top: 7px; }
    #actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
    button {
      border: 0;
      border-radius: 999px;
      padding: 8px 13px;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      color: inherit;
      background: color-mix(in srgb, currentColor 11%, transparent);
    }
    #approve, #approveAlways { background: color-mix(in srgb, currentColor 18%, transparent); }
    button:disabled { cursor: default; opacity: 0.45; }
    @media (max-width: 430px) {
      .row { grid-template-columns: 76px minmax(0, 1fr); }
      #card { padding: 12px; }
    }
  </style>
</head>
<body>
  <div id="card">
    <div id="title">CCM approval</div>
    <div id="justification"></div>
    <div class="row"><div class="label">Workspace</div><div class="value" id="workspace"></div></div>
    <div class="row"><div class="label">Environment</div><div class="value" id="environment"></div></div>
    <div class="row"><div class="label">Expires</div><div class="value" id="expires"></div></div>
    <div class="row" id="policyScopeRow" hidden><div class="label">Always allow</div><div class="value" id="policyScope"></div></div>
    <div id="command"></div>
    <div id="status" aria-live="polite">Waiting for your decision.</div>
    <div id="handleRow" hidden>
      <div class="label">Workspace handle (workspace_handle)</div>
      <code id="handleElement"></code>
      <button id="copyHandle" type="button">Copy handle</button>
    </div>
    <div id="actions">
      <button id="deny" type="button" disabled>Deny</button>
      <button id="approve" type="button" disabled>Approve once</button>
      <button id="approveAlways" type="button">Always allow in workspace</button>
    </div>
  </div>
  <script>
    (() => {
      const PROTOCOL_VERSION = "2026-01-26";
      const pending = new Map();
      let nextId = 1;
      let approval = null;
      let approvalNonce = null;
      let busy = false;
      let retryDecision = null;
      let hostCapabilities = {};
      let continuationStarted = false;
      let bridgeInitialized = false;
      let verified = false;
      let finalOutcome = null;
      let activeApprovalId = null;
      let queryGeneration = 0;

      const title = document.getElementById("title");
      const justification = document.getElementById("justification");
      const workspace = document.getElementById("workspace");
      const environment = document.getElementById("environment");
      const expires = document.getElementById("expires");
      const policyScopeRow = document.getElementById("policyScopeRow");
      const policyScope = document.getElementById("policyScope");
      const command = document.getElementById("command");
      const status = document.getElementById("status");
      const handleRow = document.getElementById("handleRow");
      const handleElement = document.getElementById("handleElement");
      const copyHandle = document.getElementById("copyHandle");
      const approve = document.getElementById("approve");
      const approveAlways = document.getElementById("approveAlways");
      const deny = document.getElementById("deny");

      function post(message) {
        window.parent.postMessage(message, "*");
      }

      function request(method, params, timeoutMs = 30000) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(method + " timed out"));
          }, timeoutMs);
          pending.set(id, { resolve, reject, timer });
          post({ jsonrpc: "2.0", id, method, params });
        });
      }

      function toolEnvelope() {
        const metadata = window.openai?.toolResponseMetadata;
        return metadata && (
          metadata.mcp_tool_result || metadata.call_tool_result
        ) || null;
      }

      function readInitialResult(result = null) {
        const envelope = result || toolEnvelope();
        const structured = envelope?.structuredContent ||
          window.openai?.toolOutput || null;
        const hidden = envelope?._meta || {};
        if (!structured) return false;
        if (structured.approval_id && structured.approval_id === activeApprovalId) {
          // Replayed pending data cannot undo a later, confirmed terminal result.
          return true;
        }
        activeApprovalId = structured.approval_id || null;
        queryGeneration++;
        approval = structured;
        approvalNonce = hidden.approval_nonce || null;
        verified = false;
        finalOutcome = null;
        handleRow.hidden = true;
        handleElement.textContent = '';
        copyHandle.textContent = 'Copy handle';
        retryDecision = null;
        const workspaceAction = structured.kind === "workspace";
        title.textContent = workspaceAction
          ? (structured.operation === "register_workspace"
              ? "CCM requests workspace registration"
              : structured.operation === "unregister_workspace"
                ? "CCM requests workspace deregistration"
                : "CCM requests workspace access")
          : "CCM requests full-access execution";
        justification.textContent = structured.justification ||
          (workspaceAction
            ? "Allow this frozen workspace action?"
            : "Run this command once with full-access outside the CCM sandbox?");
        workspace.textContent = [
          structured.workspace_id,
          structured.workspace_root
        ].filter(Boolean).join(" · ") || structured.workspace_handle || "Unknown";
        environment.textContent = structured.environment_id || "Unknown";
        expires.textContent = structured.expires_at || "";
        const policyPersistable =
          !workspaceAction && structured.policy_persistable === true;
        policyScopeRow.hidden = !policyPersistable;
        if (policyPersistable) {
          const prefix = Array.isArray(structured.prefix_rule)
            ? structured.prefix_rule.join(" ")
            : "";
          policyScope.textContent = structured.policy_kind === "package_script"
            ? "Hash-bound package script: " + prefix
            : "Token prefix: " + prefix;
        } else {
          policyScope.textContent = "";
        }
        command.textContent = workspaceAction
          ? (structured.operation === "register_workspace"
              ? (structured.create_if_missing
                  ? "Create if missing, register, and enter this exact workspace."
                  : "Register and enter this exact workspace.")
              : structured.operation === "unregister_workspace"
                ? "Remove this workspace registration and revoke its handles. Do not delete project files. Running processes are not stopped."
                : "Enter this exact registered workspace.")
          : (structured.command || "");
        approve.textContent = workspaceAction ? "Approve" : "Approve once";
        approveAlways.hidden = !policyPersistable;
        approveAlways.disabled = !policyPersistable;
        if (structured.policy_auto_approved) {
          setStatus(
            "Automatically allowed by workspace policy" +
            (structured.policy_rule_id ? " (" + structured.policy_rule_id + ")." : ".")
          );
          approve.disabled = true;
          approveAlways.disabled = true;
          deny.disabled = true;
          updateHeight();
          return true;
        }
        if (!structured.approval_id) return false;
        setStatus("Verifying approval state...");
        approve.disabled = true;
        approveAlways.disabled = true;
        deny.disabled = true;
        restoreWidgetSnapshot();
        if (bridgeInitialized) void verifyCardState();
        updateHeight();
        return true;
      }

      function updateHeight() {
        try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
      }

      function setStatus(text, error = false) {
        status.textContent = text || "";
        status.dataset.error = error ? "true" : "false";
        updateHeight();
      }

      function validHandle(value) {
        return typeof value === 'string' &&
          /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
      }

      function isTerminal(value) {
        return ['consumed', 'denied', 'execution_unknown'].includes(value?.state);
      }

      function renderTerminal(value, { unverified = false } = {}) {
        verified = false;
        finalOutcome = value;
        approve.disabled = true;
        approveAlways.disabled = true;
        deny.disabled = true;
        handleRow.hidden = true;
        handleElement.textContent = '';
        const workspaceSuccess = value.kind === 'workspace' &&
          ['select_workspace', 'register_workspace'].includes(value.operation) &&
          value.state === 'consumed' && value.action_failed !== true &&
          validHandle(value.workspace_handle);
        if (workspaceSuccess) {
          handleElement.textContent = value.workspace_handle;
          handleRow.hidden = false;
        }
        const message = value.result_unavailable
          ? 'Approval has finished; the original outcome is no longer available.'
          : value.state === 'denied'
            ? 'Denied. No action was performed.'
            : value.state === 'execution_unknown'
              ? 'Execution outcome is unknown. Do not retry automatically.'
              : value.action_failed
                ? 'Approved, but the action failed.'
                : workspaceSuccess
                  ? 'Approved and entered the workspace.'
                  : value.state === 'consumed'
                    ? 'Approved action completed.'
                    : 'Approval finished.';
        setStatus(message + (unverified ? '\nSaved card state; server verification unavailable.' : ''));
      }

      function snapshotFor(value) {
        return {
          version: 1,
          approval_id: approval?.approval_id,
          operation_id: approval?.operation_id,
          kind: approval?.kind,
          operation: approval?.operation || null,
          state: value.state,
          action_failed: value.action_failed === true,
          ...(value.kind === 'workspace' &&
            ['select_workspace', 'register_workspace'].includes(value.operation) &&
            value.state === 'consumed' && !value.action_failed &&
            validHandle(value.workspace_handle)
            ? { workspace_handle: value.workspace_handle } : {}),
        };
      }

      function saveWidgetSnapshot(value) {
        const openai = window.openai;
        if (typeof openai?.setWidgetState !== 'function') return;
        try { Promise.resolve(openai.setWidgetState(snapshotFor(value))).catch(() => {}); }
        catch {}
      }

      function restoreWidgetSnapshot() {
        const saved = window.openai?.widgetState;
        if (!saved || saved.version !== 1 ||
            saved.approval_id !== approval?.approval_id ||
            saved.operation_id !== approval?.operation_id ||
            saved.kind !== approval?.kind ||
            saved.operation !== (approval?.operation || null) ||
            !isTerminal(saved)) return;
        renderTerminal(saved, { unverified: true });
      }

      async function verifyCardState() {
        if (!bridgeInitialized || !approval?.approval_id || !approvalNonce) {
          setStatus('Approval capability unavailable. This card cannot approve again.', true);
          return;
        }
        const generation = ++queryGeneration;
        try {
          const result = await request('tools/call', {
            name: 'get_approval_status',
            arguments: {
              approval_id: approval.approval_id,
              approval_nonce: approvalNonce
            }
          }, 12000);
          if (generation !== queryGeneration) return;
          if (result?.isError === true || !result?.structuredContent)
            throw new Error('Status not available');
          const value = result.structuredContent;
          if (value.approval_id !== approval.approval_id ||
              value.operation_id !== approval.operation_id ||
              value.kind !== approval.kind ||
              (value.operation || null) !== (approval.operation || null)) {
            throw new Error('Approval identity mismatch');
          }
          if (isTerminal(value)) {
            if (value.result_unavailable && finalOutcome && isTerminal(finalOutcome)) {
              renderTerminal(finalOutcome, { unverified: true });
            } else {
              renderTerminal(value);
              if (!value.result_unavailable) saveWidgetSnapshot(value);
            }
          } else if (value.state === 'pending' || value.state === 'approved_retryable') {
            // A valid nonce-authenticated Controller result is authoritative.
            finalOutcome = null;
            handleRow.hidden = true;
            handleElement.textContent = '';
            verified = true;
            busy = false;
            approve.disabled = false;
            deny.disabled = false;
            approveAlways.disabled = approval?.kind === 'workspace' ||
              approval?.policy_persistable !== true;
            approve.textContent = value.state === 'approved_retryable'
              ? 'Retry approved action'
              : approval.kind === 'workspace' ? 'Approve' : 'Approve once';
            setStatus(value.state === 'approved_retryable'
              ? 'Previously approved action can be retried.'
              : 'Waiting for your decision.');
          } else {
            setStatus('Approval is being processed. Reopen later to check its result.');
          }
        } catch {
          if (generation !== queryGeneration) return;
          if (finalOutcome && isTerminal(finalOutcome)) {
            renderTerminal(finalOutcome, { unverified: true });
          } else {
            setStatus('Approval status cannot be verified. This card cannot approve again.', true);
          }
        }
      }

      copyHandle.addEventListener('click', async () => {
        if (handleRow.hidden || !handleElement.textContent) return;
        try {
          if (!window.navigator?.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await window.navigator.clipboard.writeText(handleElement.textContent);
          copyHandle.textContent = 'Copied';
        } catch {
          copyHandle.textContent = 'Select the handle above to copy';
        }
        updateHeight();
      });

      function appendContinuationWarning(text) {
        const current = status.textContent.trim();
        setStatus(
          (current ? current + "\n" : "") + text,
          true
        );
      }

      function setBusy(value) {
        busy = value;
        approve.disabled = value || !approvalNonce;
        approveAlways.disabled =
          value || !approvalNonce || approval?.policy_persistable !== true;
        deny.disabled = value || !approvalNonce;
      }

      function resultSummary(structured) {
        return {
          source: "ccm.approval",
          approval_id: structured?.approval_id,
          operation_id: structured?.operation_id,
          state: structured?.state,
          kind: structured?.kind,
          operation: structured?.operation,
          workspace_handle: structured?.workspace_handle,
          environment_id: structured?.environment_id,
          workspace_id: structured?.workspace_id,
          workspace_root: structured?.workspace_root,
          session_id: structured?.session_id,
          exit_code: structured?.exit_code,
          policy_saved: structured?.policy_saved,
          policy_rule_id: structured?.policy_rule_id,
          policy_prefix_tokens: structured?.policy_prefix_tokens,
          policy_save_failed: structured?.policy_save_failed,
          policy_save_error: structured?.policy_save_error,
          action_failed: structured?.action_failed,
          output: typeof structured?.output === "string"
            ? structured.output.slice(0, 12000)
            : ""
        };
      }

      async function notifyModel(decision, structured) {
        if (continuationStarted) return;
        continuationStarted = true;
        const summary = {
          ...resultSummary(structured),
          decision
        };
        const workspaceAction =
          structured?.kind === "workspace" || approval?.kind === "workspace";
        const contextText = workspaceAction
          ? (decision === "deny"
              ? "The user denied the frozen CCM workspace action; do not retry it."
              : structured?.action_failed
                ? "The approved CCM workspace action failed safely and was consumed; request a new approval before retrying."
                : "The user approved the frozen CCM workspace action. CCM completed it and returned the workspace handle; do not recreate or retry the workspace action.")
          : (decision === "deny"
              ? "The user denied the frozen CCM full-access action."
              : decision === "approve_workspace"
                ? (structured?.policy_save_failed
                    ? "The user approved the frozen CCM action. The command already executed, but saving the persistent policy failed; do not rerun the command to retry persistence."
                    : "The user approved the frozen CCM action and asked CCM to allow future matching executions in this workspace.")
                : "The user approved the frozen CCM action and CCM handled it without a second model execution request.");
        try {
          await request("ui/update-model-context", {
            content: [{
              type: "text",
              text: contextText
            }],
            structuredContent: summary
          }, 10000);
        } catch {
          appendContinuationWarning(
            "The CCM action result is final, but ChatGPT context handoff failed. Send a message to continue."
          );
          return;
        }

        const prompt = workspaceAction
          ? "Continue from the CCM workspace approval result already placed in model context. Do not recreate or rerun the workspace action."
          : decision === "deny"
            ? "Continue after my CCM approval-card decision. I denied the frozen action; do not run it."
            : decision === "approve_workspace"
              ? "Continue from the CCM approval result already placed in model context. CCM handled the action and saved the workspace policy; do not recreate or rerun that command."
              : "Continue from the CCM approval result already placed in model context. CCM already handled the frozen approved action; do not recreate or rerun that command.";
        const supportsTextMessage = Boolean(hostCapabilities?.message?.text);
        if (supportsTextMessage) {
          try {
            const messageResult = await request("ui/message", {
              role: "user",
              content: [{
                type: "text",
                text: prompt
              }]
            }, 10000);
            if (messageResult?.isError !== true) return;
          } catch {}
        }

        const openai = window.openai;
        if (openai && typeof openai.sendFollowUpMessage === "function") {
          try {
            await openai.sendFollowUpMessage({
              prompt,
              scrollToBottom: false
            });
            return;
          } catch {}
        }

        appendContinuationWarning(
          "The CCM action result is final, but ChatGPT did not continue automatically. Send a message to continue."
        );
      }

      async function resolve(decision) {
        if (busy || !verified || finalOutcome || !approval || !approvalNonce) return;
        verified = false;
        queryGeneration++;
        if (approval.kind === "workspace" && decision === "approve_workspace") {
          return;
        }
        if (approval.kind !== "workspace" &&
            (decision === "approve" || decision === "approve_workspace")) {
          retryDecision = decision;
        }
        setBusy(true);
        const workspaceAction = approval.kind === "workspace";
        setStatus(
          decision === "deny"
            ? "Denying request…"
            : decision === "approve_workspace"
              ? "Executing and saving workspace policy…"
              : workspaceAction
                ? "Applying approved workspace action…"
                : "Executing approved action…"
        );
        try {
          const result = await request("tools/call", {
            name: "resolve_pending_action",
            arguments: {
              approval_id: approval.approval_id,
              approval_nonce: approvalNonce,
              decision
            }
          }, 120000);
          const structured = result?.structuredContent || {};
          approval = { ...approval, ...structured };
          if (structured.state === "approved_retryable") {
            approve.textContent = "Retry approved action";
            setStatus(
              structured.output ||
                (retryDecision === "approve_workspace"
                  ? "The action was not dispatched. Retry will keep the workspace policy approval."
                  : "The action was not dispatched. You can retry the same frozen action."),
              true
            );
            setBusy(false);
            verified = true;
            deny.disabled = false;
            return;
          }
          if (structured.state === "execution_unknown") {
            setStatus(structured.output || "Execution outcome is unknown. CCM will not retry automatically.", true);
          } else if (structured.action_failed) {
            setStatus(structured.output || "The approved workspace action was not performed.", true);
          } else if (structured.state === "denied") {
            setStatus(
              workspaceAction
                ? "Denied. No workspace change was made."
                : "Denied. The command was not dispatched."
            );
          } else if (structured.policy_save_failed) {
            setStatus(
              "Approved and executed, but the persistent policy was not saved. " +
                (structured.policy_save_error || ""),
              true
            );
          } else if (structured.policy_saved) {
            setStatus(
              structured.trusted_package_script
                ? "Approved, executed, and saved as a hash-bound package-script rule."
                : "Approved, executed, and saved with the displayed token-prefix scope."
            );
          } else if (structured.session_id != null) {
            setStatus("Approved and started. Session ID: " + structured.session_id);
          } else if (structured.exit_code != null) {
            setStatus("Approved and completed with exit code " + structured.exit_code + ".");
          } else if (structured.workspace_handle) {
            setStatus(structured.output || "Approved and entered workspace.");
          } else {
            setStatus(structured.output || "Decision recorded.");
          }
          if (workspaceAction && decision === 'approve' &&
              !structured.action_failed && structured.state === 'consumed' &&
              typeof structured.workspace_handle === 'string' &&
              /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(structured.workspace_handle)) {
            handleElement.textContent = structured.workspace_handle;
            handleRow.hidden = false;
            updateHeight();
          }
          approve.disabled = true;
          approveAlways.disabled = true;
          deny.disabled = true;
          if (isTerminal(structured)) {
            finalOutcome = structured;
            saveWidgetSnapshot(structured);
          }
          await notifyModel(decision, structured);
        } catch (error) {
          setBusy(false);
          approve.disabled = true;
          approveAlways.disabled = true;
          deny.disabled = true;
          setStatus('Approval result needs verification: ' +
            String(error?.message || error), true);
          void verifyCardState();
        }
      }

      approve.addEventListener("click", () => {
        void resolve(retryDecision || "approve");
      });
      approveAlways.addEventListener("click", () => {
        if (approval?.policy_persistable === true) {
          void resolve("approve_workspace");
        }
      });
      deny.addEventListener("click", () => { void resolve("deny"); });

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          clearTimeout(waiter.timer);
          if (message.error) {
            waiter.reject(new Error(message.error.message || "MCP Apps request failed"));
          } else {
            waiter.resolve(message.result);
          }
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          readInitialResult(message.params || null);
        }
      });

      window.addEventListener("openai:set_globals", () => {
        readInitialResult();
      });

      async function initialize() {
        try {
          const initialized = await request("ui/initialize", {
            protocolVersion: PROTOCOL_VERSION,
            appInfo: {
              name: "ccm-approval",
              title: "CCM approval",
              version: "0.1.0"
            },
            appCapabilities: {}
          }, 5000);
          hostCapabilities = initialized?.hostCapabilities || {};
          // Some hosts deliver openai:set_globals before ui/initialize finishes.
          // The same approval_id then makes readInitialResult() a no-op; in
          // that case the initial verification must start here instead.
          const alreadyLoaded = Boolean(activeApprovalId);
          bridgeInitialized = true;
          post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
          if (!readInitialResult()) {
            setStatus("Waiting for approval details…");
          } else if (alreadyLoaded) {
            void verifyCardState();
          }
        } catch (error) {
          setStatus(
            "Approval card initialization failed: " +
              String(error && error.message ? error.message : error),
            true
          );
        }
      }

      void initialize();
    })();
  </script>
</body>
</html>`;
