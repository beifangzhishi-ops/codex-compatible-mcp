export const APPROVAL_UI_URI = 'ui://ccm/approval-v1.html';

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
    <div id="title">CCM requests full-access execution</div>
    <div id="justification"></div>
    <div class="row"><div class="label">Workspace</div><div class="value" id="workspace"></div></div>
    <div class="row"><div class="label">Environment</div><div class="value" id="environment"></div></div>
    <div class="row"><div class="label">Expires</div><div class="value" id="expires"></div></div>
    <div id="command"></div>
    <div id="status" aria-live="polite">Waiting for your decision.</div>
    <div id="actions">
      <button id="deny" type="button">Deny</button>
      <button id="approve" type="button">Approve once</button>
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

      const justification = document.getElementById("justification");
      const workspace = document.getElementById("workspace");
      const environment = document.getElementById("environment");
      const expires = document.getElementById("expires");
      const command = document.getElementById("command");
      const status = document.getElementById("status");
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
        approval = structured;
        approvalNonce = hidden.approval_nonce || null;
        justification.textContent = structured.justification ||
          "Run this command once with full-access outside the CCM sandbox?";
        workspace.textContent = [
          structured.workspace_id,
          structured.workspace_root
        ].filter(Boolean).join(" · ") || structured.workspace_context || "Unknown";
        environment.textContent = structured.environment_id || "Unknown";
        expires.textContent = structured.expires_at || "";
        command.textContent = structured.command || "";
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
        if (!approvalNonce) {
          setStatus("Approval token is unavailable in this host.", true);
          approve.disabled = true;
          approveAlways.disabled = true;
          deny.disabled = true;
        }
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

      function setBusy(value) {
        busy = value;
        approve.disabled = value || !approvalNonce;
        approveAlways.disabled = value || !approvalNonce;
        deny.disabled = value || !approvalNonce;
      }

      function resultSummary(structured) {
        return {
          source: "ccm.approval",
          approval_id: structured?.approval_id,
          operation_id: structured?.operation_id,
          state: structured?.state,
          workspace_context: structured?.workspace_context,
          environment_id: structured?.environment_id,
          workspace_id: structured?.workspace_id,
          session_id: structured?.session_id,
          exit_code: structured?.exit_code,
          policy_saved: structured?.policy_saved,
          policy_rule_id: structured?.policy_rule_id,
          output: typeof structured?.output === "string"
            ? structured.output.slice(0, 12000)
            : ""
        };
      }

      async function notifyModel(decision, structured) {
        const summary = {
          ...resultSummary(structured),
          decision
        };
        try {
          await request("ui/update-model-context", {
            content: [{
              type: "text",
              text: decision === "deny"
                ? "The user denied the frozen CCM full-access action."
                : decision === "approve_workspace"
                  ? "The user approved the frozen CCM action and asked CCM to allow future matching executions in this workspace."
                  : "The user approved the frozen CCM action and CCM handled it without a second model execution request."
            }],
            structuredContent: summary
          }, 10000);
        } catch {}

        const openai = window.openai;
        if (!openai || typeof openai.sendFollowUpMessage !== "function") return;
        const prompt = decision === "deny"
          ? "Continue after my CCM approval-card decision. I denied the frozen action; do not run it."
          : decision === "approve_workspace"
            ? "Continue from the CCM approval result already placed in model context. CCM handled the action and saved the workspace policy; do not recreate or rerun that command."
            : "Continue from the CCM approval result already placed in model context. CCM already handled the frozen approved action; do not recreate or rerun that command.";
        try {
          await openai.sendFollowUpMessage({ prompt, scrollToBottom: false });
        } catch {}
      }

      async function resolve(decision) {
        if (busy || !approval || !approvalNonce) return;
        setBusy(true);
        setStatus(
          decision === "deny"
            ? "Denying request…"
            : decision === "approve_workspace"
              ? "Executing and saving workspace policy…"
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
            setStatus(structured.output || "The action was not dispatched. You can retry the same frozen action.", true);
            setBusy(false);
            deny.disabled = false;
            return;
          }
          if (structured.state === "execution_unknown") {
            setStatus(structured.output || "Execution outcome is unknown. CCM will not retry automatically.", true);
          } else if (structured.state === "denied") {
            setStatus("Denied. The command was not dispatched.");
          } else if (structured.policy_saved) {
            setStatus(
              "Approved, executed, and saved for future matching commands in this workspace."
            );
          } else if (structured.session_id != null) {
            setStatus("Approved and started. Session ID: " + structured.session_id);
          } else if (structured.exit_code != null) {
            setStatus("Approved and completed with exit code " + structured.exit_code + ".");
          } else {
            setStatus(structured.output || "Decision recorded.");
          }
          approve.disabled = true;
          approveAlways.disabled = true;
          deny.disabled = true;
          void notifyModel(decision, structured);
        } catch (error) {
          setStatus(
            "Approval action failed: " +
              String(error && error.message ? error.message : error),
            true
          );
          setBusy(false);
        }
      }

      approve.addEventListener("click", () => { void resolve("approve"); });
      approveAlways.addEventListener("click", () => {
        void resolve("approve_workspace");
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
          await request("ui/initialize", {
            protocolVersion: PROTOCOL_VERSION,
            appInfo: {
              name: "ccm-approval",
              title: "CCM approval",
              version: "0.1.0"
            },
            appCapabilities: {}
          }, 5000);
          post({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
          if (!readInitialResult()) {
            setStatus("Waiting for approval details…");
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
