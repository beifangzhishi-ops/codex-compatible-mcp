export const VIEW_IMAGE_UI_URI = 'ui://ccm/view-image-v2.html';
export const VIEW_IMAGE_LEGACY_UI_URI = 'ui://ccm/view-image-v1.html';

export const VIEW_IMAGE_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 8px;
      font: 12px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: transparent;
      color: var(--color-text-primary, inherit);
    }
    #frame { display: grid; gap: 6px; max-width: 100%; }
    #preview {
      display: none;
      width: auto;
      max-width: 100%;
      max-height: 560px;
      object-fit: contain;
      border-radius: 6px;
    }
    #status { opacity: 0.72; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <div id="frame">
    <img id="preview" alt="CCM view_image preview">
    <div id="status">Waiting for image result...</div>
  </div>
  <script>
    (() => {
      const PROTOCOL_VERSION = "2026-01-26";
      const preview = document.getElementById("preview");
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

      async function bridgeResult(result) {
        const image = findImage(result);
        if (!image) return;
        const key = image.mimeType + ":" + image.data.length + ":" +
          image.data.slice(0, 48);
        if (key === lastImageKey) return;
        lastImageKey = key;

        preview.src = "data:" + image.mimeType + ";base64," + image.data;
        preview.style.display = "block";

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
          : {};
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
          if (canSendMessage) {
            const label = meta.path
              ? " for " + meta.path
              : "";
            try {
              await request("ui/message", {
                role: "user",
                content: [{
                  type: "text",
                  text:
                    "CCM view_image added the requested local image" + label +
                    " to model context. Continue the current task using the image now. " +
                    "Do not call view_image again for the same image unless the user asks."
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
