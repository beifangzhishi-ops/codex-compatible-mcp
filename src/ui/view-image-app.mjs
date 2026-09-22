export const VIEW_IMAGE_UI_URI = 'ui://ccm/view-image-v4.html';
export const VIEW_IMAGE_V3_UI_URI = 'ui://ccm/view-image-v3.html';
export const VIEW_IMAGE_V2_UI_URI = 'ui://ccm/view-image-v2.html';
export const VIEW_IMAGE_LEGACY_UI_URI = 'ui://ccm/view-image-v1.html';

export const VIEW_IMAGE_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      width: 0 !important;
      height: 0 !important;
      min-width: 0 !important;
      min-height: 0 !important;
      overflow: hidden !important;
      background: transparent !important;
    }
    #frame { display: none !important; }
  </style>
</head>
<body>
  <div id="frame" aria-hidden="true"><span id="status"></span></div>
  <script>
    (() => {
      const PROTOCOL_VERSION = "2026-01-26";
      const status = document.getElementById("status");
      const pending = new Map();
      let nextId = 1;
      let hostCapabilities = {};
      let lastImageKey = "";

      function post(message) {
        window.parent.postMessage(message, "*");
      }

      function request(method, params, timeoutMs = 5000) {
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

      function findImage(result) {
        const content = Array.isArray(result && result.content)
          ? result.content
          : [];
        return content.find((item) =>
          item &&
          item.type === "image" &&
          typeof item.data === "string" &&
          typeof item.mimeType === "string"
        );
      }

      function chatGptToolResult() {
        const openai = window.openai;
        const metadata = openai && openai.toolResponseMetadata;
        return metadata && (
          metadata.mcp_tool_result || metadata.call_tool_result
        );
      }

      function followUpText(meta) {
        const label = meta.path ? " for " + meta.path : "";
        return (
          "CCM view_image added the requested local image" + label +
          " to model context. Continue the current task using the image now. " +
          "Do not call view_image again for the same image unless the user asks."
        );
      }

      async function bridgeResult(result) {
        const image = findImage(result);
        if (!image) return;
        const key = image.mimeType + ":" + image.data.length + ":" +
          image.data.slice(0, 48);
        if (key === lastImageKey) return;
        lastImageKey = key;

        const imageContext = hostCapabilities &&
          hostCapabilities.updateModelContext &&
          hostCapabilities.updateModelContext.image;
        if (!imageContext) {
          status.textContent =
            "Image rendered. This host does not advertise image model-context updates.";
          return;
        }

        const meta = result && result.structuredContent
          ? result.structuredContent
          : (result && result._meta ? result._meta : {});
        try {
          await request("ui/update-model-context", {
            content: [{
              type: "image",
              data: image.data,
              mimeType: image.mimeType
            }],
            structuredContent: {
              source: "ccm.view_image",
              path: meta.path || null,
              width: meta.width || null,
              height: meta.height || null
            }
          });
          const canSendMessage = hostCapabilities &&
            hostCapabilities.message &&
            hostCapabilities.message.text;
          const openai = window.openai;
          const canSendChatGptFollowUp = openai &&
            typeof openai.sendFollowUpMessage === "function";
          if (canSendMessage) {
            try {
              await request("ui/message", {
                role: "user",
                content: [{
                  type: "text",
                  text: followUpText(meta)
                }]
              });
              status.textContent =
                "Image placed in model context and a visual follow-up was triggered.";
            } catch (messageError) {
              status.textContent =
                "Image placed in model context, but the automatic follow-up failed: " +
                String(messageError && messageError.message
                  ? messageError.message
                  : messageError);
            }
          } else if (canSendChatGptFollowUp) {
            try {
              await openai.sendFollowUpMessage({
                prompt: followUpText(meta),
                scrollToBottom: true
              });
              status.textContent =
                "Image placed in model context and a ChatGPT follow-up was triggered.";
            } catch (messageError) {
              status.textContent =
                "Image placed in model context, but the ChatGPT follow-up failed: " +
                String(messageError && messageError.message
                  ? messageError.message
                  : messageError);
            }
          } else {
            status.textContent =
              "Image placed in model context. The host will expose it on the next user message.";
          }
        } catch (error) {
          status.textContent =
            "Image rendered, but model-context forwarding failed: " +
            String(error && error.message ? error.message : error);
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
          void bridgeResult(message.params || {});
        }
      });

      window.addEventListener("openai:set_globals", () => {
        const result = chatGptToolResult();
        if (result) void bridgeResult(result);
      });

      async function initialize() {
        try {
          const initialized = await request("ui/initialize", {
            protocolVersion: PROTOCOL_VERSION,
            appInfo: {
              name: "ccm-view-image",
              title: "CCM image preview",
              version: "0.1.0"
            },
            appCapabilities: {}
          });
          hostCapabilities = initialized && initialized.hostCapabilities
            ? initialized.hostCapabilities
            : {};
          post({
            jsonrpc: "2.0",
            method: "ui/notifications/initialized"
          });
          const result = chatGptToolResult();
          if (result) void bridgeResult(result);
        } catch (error) {
          status.textContent =
            "Image bridge initialization failed: " +
            String(error && error.message ? error.message : error);
        }
      }

      void initialize();
    })();
  </script>
</body>
</html>`;
