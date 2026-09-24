export const SEND_FILE_HANDOFF_UI_URI = 'ui://ccm/send-file-handoff.html';

export const SEND_FILE_HANDOFF_UI_HTML = String.raw`<!doctype html>
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
      width: 0;
      height: 0;
      overflow: hidden;
      background: transparent;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
        "Segoe UI", sans-serif;
    }
    body[data-error="true"] {
      width: auto;
      height: auto;
      overflow: visible;
      padding: 2px;
    }
    #error {
      max-width: 100%;
      padding: 9px 11px;
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, Canvas 95%, currentColor 5%);
      color: CanvasText;
      font-size: 12px;
      line-height: 1.4;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <div id="error" hidden aria-live="polite"></div>
  <script>
    (() => {
      const PROTOCOL_VERSION = "2026-01-26";
      const pending = new Map();
      let nextId = 1;
      let materializingKey = "";
      let completedResourceKey = "";

      const errorBox = document.getElementById("error");

      function post(message) {
        window.parent.postMessage(message, "*");
      }

      function request(method, params, timeoutMs = 15000) {
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

      function notifyHeight() {
        try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
      }

      function hideError() {
        document.body.dataset.error = "false";
        errorBox.hidden = true;
        errorBox.textContent = "";
        notifyHeight();
      }

      function showError(filename, error) {
        const message = String(error && error.message ? error.message : error);
        document.body.dataset.error = "true";
        errorBox.hidden = false;
        errorBox.textContent = (filename ? filename + ": " : "") + message;
        notifyHeight();
      }

      function structuredFrom(result) {
        if (!result || typeof result !== "object") return null;
        if (result.structuredContent &&
            typeof result.structuredContent === "object") {
          return result.structuredContent;
        }
        if (result.capability === "send_file") return result;
        return null;
      }

      function parseTransfer(result) {
        const value = structuredFrom(result);
        if (!value || value.capability !== "send_file") return null;
        if (typeof value.resource_uri !== "string" ||
            !value.resource_uri.startsWith("ccm-file:///")) {
          throw new Error("Invalid CCM file bridge URI.");
        }
        if (typeof value.filename !== "string" || !value.filename) {
          throw new Error("CCM file name is unavailable.");
        }
        if (!Number.isInteger(value.byte_length) || value.byte_length < 0) {
          throw new Error("CCM file size is invalid.");
        }
        if (typeof value.sha256 !== "string" || !value.sha256) {
          throw new Error("CCM file SHA-256 is unavailable.");
        }
        const mimeType = typeof value.mime_type === "string"
          ? value.mime_type
          : "";
        return {
          uri: value.resource_uri,
          filename: value.filename,
          mimeType,
          byteLength: value.byte_length,
          sha256: value.sha256,
          key: value.resource_uri + "|" + value.sha256
        };
      }

      function restoredState() {
        const privateContent = window.openai?.widgetState?.privateContent;
        if (!privateContent || privateContent.source !== "ccm.send_file") {
          return null;
        }
        if (typeof privateContent.resourceKey !== "string" ||
            !privateContent.resourceKey ||
            typeof privateContent.fileId !== "string" ||
            !privateContent.fileId) {
          return null;
        }
        return privateContent;
      }

      function bytesFromBase64(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return bytes;
      }

      function findReadContent(readResult, uri) {
        const contents = Array.isArray(readResult?.contents)
          ? readResult.contents
          : [];
        return contents.find((item) =>
          item && item.uri === uri && typeof item.blob === "string"
        ) || null;
      }

      function validateReadContent(content, transfer, bytes) {
        if (bytes.length !== transfer.byteLength) {
          throw new Error("CCM file resource size changed before handoff.");
        }
        const meta = content._meta || {};
        if (typeof meta.filename === "string" &&
            meta.filename !== transfer.filename) {
          throw new Error("CCM file resource name does not match handoff metadata.");
        }
        if (typeof meta.sha256 === "string" &&
            meta.sha256 !== transfer.sha256) {
          throw new Error("CCM file resource SHA-256 does not match handoff metadata.");
        }
        if (content.mimeType && transfer.mimeType &&
            content.mimeType !== transfer.mimeType) {
          throw new Error("CCM file resource MIME type does not match handoff metadata.");
        }
      }

      async function closeWidget() {
        const openai = window.openai;
        if (typeof openai?.requestClose === "function") {
          try {
            await openai.requestClose();
          } catch {}
        }
        notifyHeight();
      }

      async function processResult(result) {
        let transfer;
        try {
          transfer = parseTransfer(result);
        } catch (error) {
          showError("", error);
          return;
        }
        if (!transfer) return;

        hideError();
        const restored = restoredState();
        if (completedResourceKey === transfer.key ||
            restored?.resourceKey === transfer.key) {
          completedResourceKey = transfer.key;
          await closeWidget();
          return;
        }
        if (materializingKey) return;

        materializingKey = transfer.key;
        try {
          const openai = window.openai;
          if (!openai || typeof openai.uploadFile !== "function") {
            throw new Error("ChatGPT file upload is unavailable in this host.");
          }
          const readResult = await request("resources/read", {
            uri: transfer.uri
          });
          const content = findReadContent(readResult, transfer.uri);
          if (!content) {
            throw new Error("CCM file bridge returned no binary content.");
          }
          const bytes = bytesFromBase64(content.blob);
          validateReadContent(content, transfer, bytes);
          const mimeType = transfer.mimeType || content.mimeType ||
            "application/octet-stream";
          const file = new File([bytes], transfer.filename, {
            type: mimeType
          });
          const uploaded = await openai.uploadFile(file, { library: false });
          const fileId = uploaded && uploaded.fileId;
          if (!fileId) {
            throw new Error("ChatGPT file upload returned no fileId.");
          }
          completedResourceKey = transfer.key;
          if (typeof openai.setWidgetState === "function") {
            openai.setWidgetState({
              privateContent: {
                source: "ccm.send_file",
                resourceKey: transfer.key,
                fileId
              }
            });
          }
          await closeWidget();
        } catch (error) {
          showError(transfer.filename, error);
        } finally {
          materializingKey = "";
        }
      }

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
            waiter.reject(new Error(
              message.error.message || "MCP Apps request failed"
            ));
          } else {
            waiter.resolve(message.result);
          }
          return;
        }

        if (message.method === "ui/notifications/tool-result") {
          void processResult(message.params || {});
        }
      });

      window.addEventListener("openai:set_globals", () => {
        const result = window.openai?.toolOutput;
        if (result) void processResult(result);
      });

      async function initialize() {
        try {
          await request("ui/initialize", {
            protocolVersion: PROTOCOL_VERSION,
            appInfo: {
              name: "ccm-send-file-handoff",
              title: "CCM file handoff",
              version: "0.1.0"
            },
            appCapabilities: {}
          }, 5000);
          post({
            jsonrpc: "2.0",
            method: "ui/notifications/initialized"
          });
          const result = window.openai?.toolOutput;
          if (result) void processResult(result);
        } catch (error) {
          showError("", error);
        }
      }

      void initialize();
    })();
  </script>
</body>
</html>`;
