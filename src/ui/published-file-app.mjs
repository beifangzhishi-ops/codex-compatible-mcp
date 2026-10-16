export const PUBLISHED_FILE_UI_URI = 'ui://ccm/published-file-v1.html';

// Every publication gets one useful card: images render inline; other files
// show a filename and a Host-opened HTTPS download link.
export const PUBLISHED_FILE_UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; width: 100%; overflow-x: hidden; }
    body { font: 13px/1.4 system-ui, sans-serif; color: var(--color-text-primary, inherit); }
    #frame { width: 100%; padding: 8px; overflow-wrap: anywhere; }
    #filename { display: none; font-weight: 600; margin-bottom: 7px; }
    #picture { display: none; width: 100%; text-align: center; }
    #picture img {
      display: block; width: auto; height: auto; max-width: 100%;
      max-height: 520px; object-fit: contain;
      margin: auto; border-radius: 6px;
    }
    @media (max-width: 600px) { #picture img { max-height: 360px; } }
    #status { opacity: 0.8; }
    #details { display: none; margin-top: 7px; font-size: 12px; opacity: 0.7; }
    #link { display: none; margin-top: 8px; }
  </style>
</head>
<body>
  <div id="frame">
    <div id="filename"></div>
    <div id="picture"><img id="image" alt="CCM published image"></div>
    <div id="status">Loading published file…</div>
    <div id="details"></div>
    <a id="link" target="_blank" rel="noopener noreferrer">Download file</a>
  </div>
  <script>
    (() => {
      const frame = document.getElementById('frame');
      const filename = document.getElementById('filename');
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
          if (width > 0 && height > 0) {
            post({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { width, height } });
          }
          try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
        });
      }
      new ResizeObserver(sizeChanged).observe(frame);
      window.addEventListener('resize', sizeChanged);
      function validUrl(url, kind) {
        if (typeof url !== 'string') return false;
        try {
          const parsed = new URL(url);
          return parsed.protocol === 'https:' && !parsed.username && !parsed.password &&
            !parsed.search && !parsed.hash &&
            new RegExp('^/ccm/' + kind +
              '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', 'i')
              .test(parsed.pathname);
        } catch { return false; }
      }
      link.addEventListener('click', (event) => {
        const url = link.href;
        if (!validUrl(url, 'download')) { event.preventDefault(); return; }
        if (window.openai?.openExternal) {
          event.preventDefault();
          Promise.resolve(window.openai.openExternal({ href: url, redirectUrl: false }))
            .catch(() => request('ui/open-link', { url }).catch(() => {
              status.style.display = '';
              status.textContent = 'Could not open the link. Use the download URL from the tool response.';
              sizeChanged();
            }));
        } else {
          event.preventDefault();
          request('ui/open-link', { url }).catch(() => {
            status.style.display = '';
            status.textContent = 'Could not open the link. Use the download URL from the tool response.';
            sizeChanged();
          });
        }
      });
      function show(result) {
        const value = result?.structuredContent || result;
        if (value?.capability !== 'publish_worker_file') return;
        const downloadUrl = value.download_url;
        if (!validUrl(downloadUrl, 'download')) {
          status.textContent = 'Invalid CCM download URL.';
          sizeChanged();
          return;
        }
        if (downloadUrl === lastUrl) return;
        lastUrl = downloadUrl;
        filename.textContent = typeof value.filename === 'string' ? value.filename : 'Published file';
        filename.style.display = 'block';
        link.href = downloadUrl;
        link.textContent = 'Download file';
        link.style.display = 'block';
        picture.style.display = 'none';
        details.style.display = 'none';
        const previewUrl = value.preview_url;
        if (!validUrl(previewUrl, 'preview') ||
            previewUrl.split('/').at(-1) !== downloadUrl.split('/').at(-1)) {
          status.style.display = 'none';
          image.removeAttribute('src');
          sizeChanged();
          return;
        }
        status.style.display = '';
        status.textContent = 'Loading image preview…';
        image.onload = () => {
          picture.style.display = 'block';
          status.style.display = 'none';
          details.textContent = image.naturalWidth + ' × ' + image.naturalHeight + ' · fit entire image';
          details.style.display = 'block';
          sizeChanged();
        };
        image.onerror = () => {
          status.textContent = 'Image preview unavailable; download link is still available.';
          sizeChanged();
        };
        image.src = previewUrl;
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
            appInfo: { name: 'ccm-published-file', version: '1.0.0' },
            appCapabilities: {},
          });
          post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
          show(window.openai?.toolOutput);
        } catch (error) {
          status.textContent = 'CCM file UI handshake failed: ' + String(error?.message || error);
        }
        sizeChanged();
      }
      void initialize();
    })();
  </script>
</body>
</html>`;
