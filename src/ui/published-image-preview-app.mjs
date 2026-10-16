export const PUBLISHED_IMAGE_PREVIEW_UI_URI = 'ui://ccm/published-image-preview-v1.html';

// Deliberately separate from the ordinary file publisher: only an explicit
// preview test creates an iframe, avoiding background cards for every file.
export const PUBLISHED_IMAGE_PREVIEW_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; overflow-x: hidden; }
    body { font: 13px/1.4 system-ui, sans-serif; color: var(--color-text-primary, inherit); }
    #frame { width: 100%; padding: 6px; }
    #picture { display: none; width: 100%; text-align: center; }
    #picture img {
      display: block; width: auto; height: auto; max-width: 100%;
      max-height: 520px; object-fit: contain;
      margin: auto; border-radius: 6px;
    }
    @media (max-width: 600px) { #picture img { max-height: 360px; } }
    #status { overflow-wrap: anywhere; opacity: 0.8; }
    #details { display: none; margin-top: 7px; font-size: 12px; opacity: 0.7; }
    #link { display: none; margin-top: 6px; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <div id="frame">
    <div id="picture"><img id="image" alt="CCM published image preview"></div>
    <div id="status">Loading CCM image preview…</div>
    <div id="details"></div>
    <a id="link" target="_blank" rel="noopener noreferrer">Open original image</a>
  </div>
  <script>
    (() => {
      const frame = document.getElementById('frame');
      const picture = document.getElementById('picture');
      const image = document.getElementById('image');
      const status = document.getElementById('status');
      const details = document.getElementById('details');
      const link = document.getElementById('link');
      let seq = 1;
      const pending = new Map();
      let lastUrl = '';
      function post(message) { window.parent.postMessage(message, '*'); }
      function request(method, params) {
        const id = seq++;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(id); reject(Error('UI timeout')); }, 5000);
          pending.set(id, { resolve, reject, timeout });
          post({ jsonrpc: '2.0', id, method, params });
        });
      }
      let scheduled = false;
      function sizeChanged() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const width = Math.ceil(document.documentElement.getBoundingClientRect().width);
          const height = Math.ceil(frame.getBoundingClientRect().height);
          if (width > 0 && height > 0) post({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width, height } });
          try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
        });
      }
      new ResizeObserver(sizeChanged).observe(frame);
      window.addEventListener('resize', sizeChanged);
      function show(result) {
        const value = result?.structuredContent || result;
        if (value?.capability !== 'preview_published_image') return;
        const url = value.preview_url;
        if (typeof url !== 'string' || !/^https:\/\/[^/?#]+\/ccm\/preview\/[0-9a-f-]{36}$/i.test(url)) {
          status.textContent = 'Invalid CCM preview URL.';
          sizeChanged();
          return;
        }
        if (url === lastUrl) return;
        lastUrl = url;
        status.textContent = 'Loading CCM image preview…';
        status.style.display = '';
        picture.style.display = 'none';
        details.style.display = 'none';
        link.style.display = 'none';
        image.onload = () => {
          picture.style.display = 'block';
          status.style.display = 'none';
          details.textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' · fit entire image';
          details.style.display = 'block';
          link.style.display = 'block';
          sizeChanged();
        };
        image.onerror = () => {
          status.textContent = 'Preview failed to load. Use the original link below.';
          link.style.display = 'block';
          sizeChanged();
        };
        link.href = url;
        image.src = url;
        sizeChanged();
      }
      window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return;
        const data = event.data;
        if (!data || data.jsonrpc !== '2.0') return;
        if (Object.hasOwn(data, 'id')) {
          const item = pending.get(data.id);
          if (!item) return;
          clearTimeout(item.timeout);
          pending.delete(data.id);
          if (data.error) item.reject(Error(data.error.message || 'UI error'));
          else item.resolve(data.result);
          return;
        }
        if (data.method === 'ui/notifications/tool-result') show(data.params);
      });
      async function initialize() {
        try {
          await request('ui/initialize', {
            protocolVersion: '2026-01-26',
            appInfo: { name: 'ccm-image-preview-test', version: '0.1.0' },
            appCapabilities: {},
          });
          post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
          show(window.openai?.toolOutput);
        } catch (error) {
          status.textContent = 'CCM preview UI handshake failed: ' + String(error?.message || error);
        }
        sizeChanged();
      }
      void initialize();
    })();
  </script>
</body>
</html>`;
