export const WORKSPACE_HANDLE_UI_URI = 'ui://ccm/workspace-handle-v1.html';

// A read-only card for successfully entered registered projects only.
export const WORKSPACE_HANDLE_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 13px/1.4 system-ui, sans-serif; }
    #card { padding: 12px; border: 1px solid color-mix(in srgb, currentColor 16%, transparent); border-radius: 12px; overflow-wrap: anywhere; }
    #title { font-weight: 700; margin-bottom: 4px; }
    #project { opacity: .75; font-size: 12px; }
    #handle { display: block; margin-top: 10px; padding: 9px; background: color-mix(in srgb, currentColor 7%, transparent); border-radius: 6px; font: 12px/1.5 ui-monospace, monospace; user-select: text; overflow-wrap: anywhere; }
    #actions { text-align: right; margin-top: 8px; }
    #copy { border: 0; border-radius: 8px; padding: 7px 12px; font: inherit; cursor: pointer; color: inherit; background: color-mix(in srgb, currentColor 12%, transparent); }
    #status { font-size: 11px; opacity: .75; margin-top: 4px; }
  </style>
</head>
<body>
  <div id="card" hidden>
    <div id="title">CCM workspace handle (workspace_handle)</div>
    <div id="project"></div>
    <code id="handle"></code>
    <div id="actions"><button id="copy" type="button">Copy handle</button></div>
    <div id="status">You can also select and copy the handle above.</div>
  </div>
  <script>
    (() => {
      const card = document.getElementById('card');
      const project = document.getElementById('project');
      const handle = document.getElementById('handle');
      const status = document.getElementById('status');
      const copy = document.getElementById('copy');
      let current = '';
      let requestId = 1;
      const pending = new Map();
      function post(message) { window.parent.postMessage(message, '*'); }
      function show(result) {
        const value = result?.structuredContent || result;
        const valid = value?.workspace_kind === 'registered' &&
          typeof value.workspace_handle === 'string' &&
          /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.workspace_handle) &&
          typeof value.environment_id === 'string' &&
          typeof value.workspace_id === 'string' &&
          value.approval_required !== true && value.action_failed !== true;
        card.hidden = !valid;
        if (valid) {
          current = value.workspace_handle;
          project.textContent = value.environment_id + ' / ' + value.workspace_id;
          handle.textContent = current;
        } else {
          current = '';
          handle.textContent = '';
        }
        try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
      }
      copy.addEventListener('click', async () => {
        if (!current) return;
        try {
          if (!window.navigator?.clipboard?.writeText) throw Error('unavailable');
          await window.navigator.clipboard.writeText(current);
          status.textContent = 'Copied';
        } catch {
          status.textContent = 'Select the handle above to copy it.';
        }
      });
      window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || data.jsonrpc !== '2.0') return;
        if (Object.hasOwn(data, 'id')) {
          const callback = pending.get(data.id);
          if (callback) { pending.delete(data.id); callback(data); }
        } else if (data.method === 'ui/notifications/tool-result') {
          show(data.params);
        }
      });
      window.addEventListener('openai:set_globals', () => show(window.openai?.toolOutput));
      function initialize() {
        const id = requestId++;
        pending.set(id, () => {
          post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
          show(window.openai?.toolOutput);
        });
        post({ jsonrpc: '2.0', id, method: 'ui/initialize', params: {
          protocolVersion: '2026-01-26',
          appInfo: { name: 'ccm-workspace-handle', version: '1.0.0' },
          appCapabilities: {}
        } });
      }
      initialize();
    })();
  </script>
</body>
</html>`;
