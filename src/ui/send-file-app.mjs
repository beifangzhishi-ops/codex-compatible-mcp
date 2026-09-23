export const SEND_FILE_UI_URI = 'ui://ccm/send-file-v1.html';

export const SEND_FILE_UI_HTML = String.raw`<!doctype html>
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
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      min-width: 0;
      padding: 12px 14px;
      border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
      border-radius: 14px;
      background: color-mix(in srgb, Canvas 94%, currentColor 6%);
      color: CanvasText;
    }
    #icon {
      flex: 0 0 auto;
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border-radius: 9px;
      background: color-mix(in srgb, currentColor 9%, transparent);
      font-size: 17px;
      line-height: 1;
    }
    #body { flex: 1 1 auto; min-width: 0; }
    #file-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.35;
    }
    #file-meta, #status {
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      line-height: 1.3;
      opacity: 0.68;
    }
    #status[data-error="true"] { opacity: 1; }
    #download {
      flex: 0 0 auto;
      border: 0;
      border-radius: 999px;
      padding: 8px 12px;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      background: color-mix(in srgb, currentColor 12%, transparent);
      color: inherit;
    }
    #download:disabled { cursor: default; opacity: 0.45; }
    @media (max-width: 380px) {
      #card { gap: 9px; padding: 10px 11px; }
      #download { padding: 7px 10px; }
    }
  </style>
</head>
<body>
  <div id="card">
    <div id="icon" aria-hidden="true">↧</div>
    <div id="body">
      <div id="file-name">Preparing file…</div>
      <div id="file-meta"></div>
      <div id="status" aria-live="polite">Preparing a persistent download…</div>
    </div>
    <button id="download" type="button" disabled>Download</button>
  </div>
  <script>
    (() => {
      const PROTOCOL_VERSION = "2026-01-26";
      const pending = new Map();
      let nextId = 1;
      let current = null;
      let materializingKey = "";
      let completedResourceKey = "";
      let lastResult = null;
      let lastResource = null;

      const fileName = document.getElementById("file-name");
      const fileMeta = document.getElementById("file-meta");
      const status = document.getElementById("status");
      const download = document.getElementById("download");
      const icon = document.getElementById("icon");

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

      function chatGptToolResult() {
        const openai = window.openai;
        const metadata = openai && openai.toolResponseMetadata;
        return metadata && (
          metadata.mcp_tool_result || metadata.call_tool_result
        );
      }

      function findResourceLink(result) {
        const content = Array.isArray(result && result.content)
          ? result.content
          : [];
        return content.find((item) =>
          item &&
          item.type === "resource_link" &&
          typeof item.uri === "string" &&
          typeof item.name === "string"
        ) || null;
      }

      function structuredResource(result) {
        const value = result && result.structuredContent;
        if (!value ||
            typeof value.resource_uri !== "string" ||
            !value.resource_uri.startsWith("ccm-file:///") ||
            typeof value.filename !== "string" || !value.filename) {
          return null;
        }
        return {
          uri: value.resource_uri,
          name: value.filename,
          mimeType: value.mime_type || "application/octet-stream",
          size: value.byte_length
        };
      }

      function findResource(result) {
        return structuredResource(result) || findResourceLink(result);
      }

      function formatBytes(value) {
        const bytes = Number(value || 0);
        if (!Number.isFinite(bytes) || bytes <= 0) return "";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
      }

      function updateHeight() {
        try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
      }

      function render(meta, state = null) {
        const name = state?.filename || meta?.name || "CCM file";
        const mimeType = state?.mimeType || meta?.mimeType || "";
        const size = state?.size ?? meta?.size ?? 0;
        fileName.textContent = name;
        fileMeta.textContent = [mimeType, formatBytes(size)]
          .filter(Boolean)
          .join(" · ");
        icon.textContent = mimeType.startsWith("image/") ? "▧" : "↧";
        updateHeight();
      }

      function setStatus(text, { error = false } = {}) {
        status.textContent = text || "";
        status.dataset.error = error ? "true" : "false";
        updateHeight();
      }

      function restoredState() {
        const state = window.openai?.widgetState;
        const privateContent = state && state.privateContent;
        if (!privateContent || privateContent.source !== "ccm.send_file") {
          return null;
        }
        if (typeof privateContent.fileId !== "string" || !privateContent.fileId) {
          return null;
        }
        return privateContent;
      }

      function recoveryResource(state) {
        if (!state || typeof state.resourceUri !== "string" ||
            !state.resourceUri.startsWith("ccm-file:///") ||
            typeof state.filename !== "string" || !state.filename) {
          return null;
        }
        return {
          uri: state.resourceUri,
          name: state.filename,
          mimeType: state.mimeType || "application/octet-stream",
          size: state.size
        };
      }

      function sourceSha(result) {
        return result && result.structuredContent &&
          typeof result.structuredContent.sha256 === "string"
          ? result.structuredContent.sha256
          : null;
      }

      function resourceKey(result, resource) {
        if (!resource?.uri) return "";
        return resource.uri + "|" + (sourceSha(result) || "");
      }

      function stateMatches(result, state, resource) {
        if (!state) return false;
        const sha = sourceSha(result);
        if (sha && state.sha256 !== sha) return false;
        if (resource?.name && state.filename &&
            resource.name !== state.filename) return false;
        return true;
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
        const contents = Array.isArray(readResult && readResult.contents)
          ? readResult.contents
          : [];
        return contents.find((item) =>
          item &&
          item.uri === uri &&
          typeof item.blob === "string"
        ) || contents.find((item) =>
          item && typeof item.blob === "string"
        ) || null;
      }

      function persistState(next) {
        const openai = window.openai;
        if (typeof openai?.setWidgetState === "function") {
          openai.setWidgetState({ privateContent: next });
        }
        return next;
      }

      function withRecoveryResource(state, result, resource) {
        if (!state || !resource?.uri) return state;
        const sha256 = state.sha256 || sourceSha(result);
        if (state.resourceUri === resource.uri &&
            (!sha256 || state.sha256 === sha256)) {
          return state;
        }
        return persistState({
          ...state,
          resourceUri: resource.uri,
          sha256
        });
      }

      async function materialize(result, resource, fallbackSha = null) {
        const openai = window.openai;
        if (!openai || typeof openai.uploadFile !== "function") {
          throw new Error(
            "This host does not expose ChatGPT file upload for persistent downloads."
          );
        }
        const readResult = await request("resources/read", {
          uri: resource.uri
        });
        const content = findReadContent(readResult, resource.uri);
        if (!content) {
          throw new Error("CCM file resource returned no binary content.");
        }
        const mimeType = content.mimeType || resource.mimeType ||
          "application/octet-stream";
        const bytes = bytesFromBase64(content.blob);
        if (Number.isFinite(resource.size) &&
            Number(resource.size) >= 0 &&
            bytes.length !== Number(resource.size)) {
          throw new Error(
            "CCM file resource size changed before materialization."
          );
        }
        const file = new File([bytes], resource.name, { type: mimeType });
        const uploaded = await openai.uploadFile(file, { library: false });
        const fileId = uploaded && uploaded.fileId;
        if (!fileId) {
          throw new Error("ChatGPT uploadFile returned no fileId.");
        }
        const next = {
          source: "ccm.send_file",
          fileId,
          filename: resource.name,
          mimeType,
          size: bytes.length,
          sha256: sourceSha(result) || fallbackSha,
          resourceUri: resource.uri
        };
        return persistState(next);
      }

      async function processResult(result) {
        const resource = findResource(result);
        const key = resourceKey(result, resource);
        lastResult = result || null;
        lastResource = resource;
        const restored = restoredState();
        if (!resource) {
          if (restored) {
            current = restored;
            render(null, restored);
            download.disabled = false;
            setStatus("Ready");
            return;
          }
          setStatus("No downloadable CCM file was returned.", { error: true });
          return;
        }
        render(resource, restored);
        if (stateMatches(result, restored, resource)) {
          current = withRecoveryResource(restored, result, resource);
          completedResourceKey = key;
          download.disabled = false;
          setStatus("Ready");
          return;
        }
        if (completedResourceKey === key && current?.fileId) {
          render(resource, current);
          download.disabled = false;
          setStatus("Ready");
          return;
        }
        if (materializingKey === key) return;
        materializingKey = key;
        download.disabled = true;
        setStatus("Saving this file to the current ChatGPT conversation…");
        try {
          current = await materialize(result, resource);
          completedResourceKey = key;
          render(resource, current);
          download.disabled = false;
          setStatus("Ready");
        } catch (error) {
          current = null;
          download.disabled = true;
          setStatus(
            "Could not create a persistent download: " +
              String(error && error.message ? error.message : error),
            { error: true }
          );
        } finally {
          materializingKey = "";
        }
      }

      async function downloadCurrent() {
        if (!current?.fileId) return;
        const openai = window.openai;
        if (!openai || typeof openai.getFileDownloadUrl !== "function") {
          setStatus(
            "This host cannot create a fresh download URL for the saved file.",
            { error: true }
          );
          return;
        }
        download.disabled = true;
        setStatus("Preparing download…");
        try {
          let response;
          try {
            response = await openai.getFileDownloadUrl({
              fileId: current.fileId
            });
          } catch (firstError) {
            const resource = lastResource || recoveryResource(current);
            if (!resource) throw firstError;
            setStatus("Refreshing saved file…");
            try {
              current = await materialize(
                lastResult,
                resource,
                current.sha256 || null
              );
            } catch (recoveryError) {
              throw new Error(
                "Saved ChatGPT file expired and the CCM recovery resource " +
                "could not be read: " +
                String(
                  recoveryError && recoveryError.message
                    ? recoveryError.message
                    : recoveryError
                )
              );
            }
            render(resource, current);
            response = await openai.getFileDownloadUrl({
              fileId: current.fileId
            });
          }
          const downloadUrl = response && response.downloadUrl;
          if (!downloadUrl) {
            throw new Error("ChatGPT returned no download URL.");
          }
          const anchor = document.createElement("a");
          anchor.href = downloadUrl;
          anchor.download = current.filename || "";
          anchor.rel = "noopener";
          anchor.style.display = "none";
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setStatus("Ready");
        } catch (error) {
          setStatus(
            "Download failed: " +
              String(error && error.message ? error.message : error),
            { error: true }
          );
        } finally {
          download.disabled = false;
        }
      }

      download.addEventListener("click", () => {
        void downloadCurrent();
      });

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
        const restored = restoredState();
        if (restored && !current) {
          current = restored;
          render(null, restored);
          download.disabled = false;
          setStatus("Ready");
        }
        const result = chatGptToolResult();
        if (result) void processResult(result);
      });

      async function initialize() {
        const restored = restoredState();
        if (restored) {
          current = restored;
          render(null, restored);
          download.disabled = false;
          setStatus("Ready");
        }
        try {
          await request("ui/initialize", {
            protocolVersion: PROTOCOL_VERSION,
            appInfo: {
              name: "ccm-send-file",
              title: "CCM file",
              version: "0.1.0"
            },
            appCapabilities: {}
          }, 5000);
          post({
            jsonrpc: "2.0",
            method: "ui/notifications/initialized"
          });
          const result = chatGptToolResult();
          if (result) void processResult(result);
        } catch (error) {
          if (!current) {
            setStatus(
              "File card initialization failed: " +
                String(error && error.message ? error.message : error),
              { error: true }
            );
          }
        }
      }

      void initialize();
    })();
  </script>
</body>
</html>`;
