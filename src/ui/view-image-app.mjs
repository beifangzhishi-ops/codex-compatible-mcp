export const VIEW_IMAGE_UI_URI = 'ui://ccm/view-image-v6.html';
export const VIEW_IMAGE_V5_UI_URI = 'ui://ccm/view-image-v5.html';
export const VIEW_IMAGE_V4_UI_URI = 'ui://ccm/view-image-v4.html';
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

      function collapseUi() {
        const openai = window.openai;
        try {
          if (openai && typeof openai.notifyIntrinsicHeight === "function") {
            openai.notifyIntrinsicHeight({ height: 0 });
          }
        } catch {}
        post({
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: { height: 0, width: 0 }
        });
      }

      async function closeUi() {
        collapseUi();
        const openai = window.openai;
        if (!openai || typeof openai.requestClose !== "function") return;
        try {
          await openai.requestClose();
        } catch {}
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

      function imageFileName(meta, image) {
        const raw = meta && typeof meta.path === "string"
          ? meta.path.split(/[\\/]/).pop()
          : "";
        if (raw) return raw;
        const subtype = image.mimeType.split("/")[1] || "png";
        return "ccm-view-image." + subtype.replace(/[^a-z0-9.+-]/gi, "");
      }

      function imageFile(image, meta) {
        const binary = atob(image.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return new File(
          [bytes],
          imageFileName(meta, image),
          { type: image.mimeType }
        );
      }

      async function triggerFollowUp(meta) {
        const openai = window.openai;
        if (openai && typeof openai.sendFollowUpMessage === "function") {
          await openai.sendFollowUpMessage({
            prompt: followUpText(meta),
            scrollToBottom: true
          });
          return true;
        }
        const canSendMessage = hostCapabilities &&
          hostCapabilities.message &&
          hostCapabilities.message.text;
        if (!canSendMessage) return false;
        await request("ui/message", {
          role: "user",
          content: [{ type: "text", text: followUpText(meta) }]
        });
        return true;
      }

      async function bridgeViaChatGptFile(image, meta) {
        const openai = window.openai;
        if (!openai ||
            typeof openai.uploadFile !== "function" ||
            typeof openai.setWidgetState !== "function") {
          return false;
        }
        const uploaded = await openai.uploadFile(
          imageFile(image, meta),
          { library: false }
        );
        const fileId = uploaded && uploaded.fileId;
        if (!fileId) throw new Error("ChatGPT uploadFile returned no fileId");
        openai.setWidgetState({
          modelContent: "Review the image supplied by CCM view_image.",
          privateContent: {
            source: "ccm.view_image",
            path: meta.path || null,
            mimeType: image.mimeType,
            fileId
          },
          imageIds: [fileId]
        });
        await triggerFollowUp(meta);
        return true;
      }

      async function bridgeResult(result) {
        collapseUi();
        const image = findImage(result);
        if (!image) {
          await closeUi();
          return;
        }
        const key = image.mimeType + ":" + image.data.length + ":" +
          image.data.slice(0, 48);
        if (key === lastImageKey) return;
        lastImageKey = key;

        const meta = result && result.structuredContent
          ? result.structuredContent
          : (result && result._meta ? result._meta : {});

        const imageContext = hostCapabilities &&
          hostCapabilities.updateModelContext &&
          hostCapabilities.updateModelContext.image;
        if (!imageContext) {
          try {
            if (await bridgeViaChatGptFile(image, meta)) {
              status.textContent =
                "Image added through ChatGPT file state for the next model turn.";
              await closeUi();
              return;
            }
          } catch (error) {
            status.textContent =
              "ChatGPT file-state image bridge failed: " +
              String(error && error.message ? error.message : error);
            await closeUi();
            return;
          }
          status.textContent = "No supported image-to-model bridge is available.";
          await closeUi();
          return;
        }
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
          try {
            const triggered = await triggerFollowUp(meta);
            status.textContent = triggered
              ? "Image placed in model context and a visual follow-up was triggered."
              : "Image placed in model context for the next user message.";
          } catch (messageError) {
            status.textContent =
              "Image placed in model context, but the follow-up failed: " +
              String(messageError && messageError.message
                ? messageError.message
                : messageError);
          }
          await closeUi();
        } catch (error) {
          status.textContent =
            "Image rendered, but model-context forwarding failed: " +
            String(error && error.message ? error.message : error);
          await closeUi();
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
        collapseUi();
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
          await closeUi();
        }
      }

      void initialize();
    })();
  </script>
</body>
</html>`;
