export const PUBLISHED_FILE_UI_URI = 'ui://ccm/published-file-v4.html';

// Every publication gets one useful card: images render inline, text shows a
// bounded plain-text excerpt, and all files retain a download link.
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
    #picture { display: none; width: 100%; }
    #viewport {
      position: relative; width: 100%; overflow: hidden; border-radius: 6px;
      touch-action: none; user-select: none; -webkit-user-select: none;
    }
    #image { position: absolute; left: 50%; top: 50%; display: block;
      max-width: none; max-height: none; pointer-events: none; user-select: none; }
    #image-controls { display: flex; align-items: center; gap: 9px; margin-top: 7px; flex-wrap: wrap; }
    #reset { display: none; font: inherit; padding: 3px 7px; cursor: pointer;
      border: 1px solid rgba(127,127,127,.4); border-radius: 5px;
      color: inherit; background: transparent; }
    #image-link { display: none; }
    #text-preview {
      display: none; max-height: 220px; max-width: 100%; overflow: hidden;
      white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4;
      margin: 0; padding: 10px; font: 12px/1.5 ui-monospace, monospace;
      background: rgba(127, 127, 127, 0.10); border-radius: 6px;
      user-select: text;
    }
    #text-note { display: none; margin-top: 5px; font-size: 11px; opacity: 0.65; }
    #status { opacity: 0.8; }
    #details { display: none; margin-top: 7px; font-size: 12px; opacity: 0.7; }
    #link, #full-link { display: none; margin-top: 8px; }
  </style>
</head>
<body>
  <div id="frame">
    <div id="filename"></div>
    <div id="picture">
      <div id="viewport"><img id="image" alt="CCM published image" draggable="false"></div>
      <div id="image-controls">
        <button id="reset" type="button">Fit image</button>
        <a id="image-link" target="_blank" rel="noopener noreferrer">View original</a>
      </div>
    </div>
    <pre id="text-preview"></pre>
    <div id="text-note"></div>
    <div id="status">Loading published file…</div>
    <div id="details"></div>
    <a id="full-link" target="_blank" rel="noopener noreferrer">View full text</a>
    <a id="link" target="_blank" rel="noopener noreferrer">Download file</a>
  </div>
  <script>
    (() => {
      const frame = document.getElementById('frame');
      const filename = document.getElementById('filename');
      const picture = document.getElementById('picture');
      const viewport = document.getElementById('viewport');
      const image = document.getElementById('image');
      const reset = document.getElementById('reset');
      const imageLink = document.getElementById('image-link');
      const textPreview = document.getElementById('text-preview');
      const textNote = document.getElementById('text-note');
      const status = document.getElementById('status');
      const details = document.getElementById('details');
      const link = document.getElementById('link');
      const fullLink = document.getElementById('full-link');
      let seq = 1;
      const pending = new Map();
      let lastUrl = '';
      const pointers = new Map();
      let mouseDrag = null;
      let zoom = 1;
      let offsetX = 0;
      let offsetY = 0;
      let baseWidth = 0;
      let baseHeight = 0;
      let viewportWidth = 0;
      let viewportHeight = 0;
      let textWasTruncated = false;
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const localPoint = (e) => {
        const rect = viewport.getBoundingClientRect();
        return { x: e.clientX - rect.left - rect.width / 2,
          y: e.clientY - rect.top - rect.height / 2 };
      };
      function renderImage() {
        const maxX = Math.max(0, (baseWidth * zoom - viewportWidth) / 2);
        const maxY = Math.max(0, (baseHeight * zoom - viewportHeight) / 2);
        offsetX = clamp(offsetX, -maxX, maxX);
        offsetY = clamp(offsetY, -maxY, maxY);
        image.style.transform = 'translate(calc(-50% + ' + offsetX + 'px), calc(-50% + ' +
          offsetY + 'px)) scale(' + zoom + ')';
        reset.style.display = zoom > 1 ? 'inline-block' : 'none';
      }
      function resetImage() {
        zoom = 1; offsetX = 0; offsetY = 0;
        renderImage();
      }
      function clearGestures() {
        const ids = [...pointers.keys()];
        if (mouseDrag) ids.push(mouseDrag.id);
        pointers.clear();
        mouseDrag = null;
        for (const id of ids) {
          try { if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id); } catch {}
        }
      }
      function layoutImage() {
        if (picture.style.display !== 'block' || !image.naturalWidth || !image.naturalHeight) return;
        const width = viewport.getBoundingClientRect().width;
        if (!width) return;
        const maxHeight = window.matchMedia?.('(max-width: 600px)').matches ? 360 : 520;
        const fit = Math.min(1, width / image.naturalWidth, maxHeight / image.naturalHeight);
        baseWidth = image.naturalWidth * fit;
        baseHeight = image.naturalHeight * fit;
        viewportWidth = width;
        viewportHeight = baseHeight;
        image.style.width = baseWidth + 'px';
        image.style.height = baseHeight + 'px';
        viewport.style.height = baseHeight + 'px';
        renderImage();
      }
      function zoomAt(nextZoom, point) {
        const next = clamp(nextZoom, 1, 6);
        const ratio = next / zoom;
        offsetX = point.x - (point.x - offsetX) * ratio;
        offsetY = point.y - (point.y - offsetY) * ratio;
        zoom = next;
        renderImage();
      }
      function pair() {
        const [a, b] = [...pointers.values()];
        return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          distance: Math.hypot(a.x - b.x, a.y - b.y) };
      }
      viewport.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'touch' && pointers.size < 2) {
          pointers.set(e.pointerId, localPoint(e));
          try { viewport.setPointerCapture(e.pointerId); } catch {}
        } else if (e.pointerType === 'mouse' && e.button === 1 && mouseDrag === null) {
          e.preventDefault();
          mouseDrag = { id: e.pointerId, point: localPoint(e) };
          try { viewport.setPointerCapture(e.pointerId); } catch {}
        }
      });
      viewport.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'touch' && pointers.has(e.pointerId)) {
          const previous = pointers.size === 2 ? pair() : null;
          const old = pointers.get(e.pointerId);
          const next = localPoint(e);
          pointers.set(e.pointerId, next);
          if (previous) {
            const current = pair();
            if (previous.distance > 0) zoomAt(zoom * current.distance / previous.distance, previous.center);
            offsetX += current.center.x - previous.center.x;
            offsetY += current.center.y - previous.center.y;
            renderImage();
          } else if (zoom > 1) {
            offsetX += next.x - old.x;
            offsetY += next.y - old.y;
            renderImage();
          }
        } else if (mouseDrag?.id === e.pointerId) {
          const next = localPoint(e);
          offsetX += next.x - mouseDrag.point.x;
          offsetY += next.y - mouseDrag.point.y;
          mouseDrag.point = next;
          renderImage();
        }
      });
      function endPointer(e) {
        pointers.delete(e.pointerId);
        if (mouseDrag?.id === e.pointerId) mouseDrag = null;
      }
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        viewport.addEventListener(type, endPointer);
      }
      viewport.addEventListener('wheel', (e) => {
        if (!baseWidth) return;
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewportHeight : 1;
        zoomAt(zoom * Math.exp(-e.deltaY * unit / 300), localPoint(e));
      }, { passive: false });
      for (const type of ['mousedown', 'auxclick']) {
        viewport.addEventListener(type, (e) => { if (e.button === 1) e.preventDefault(); });
      }
      reset.addEventListener('click', resetImage);
      function updateTextNote() {
        if (textPreview.style.display !== 'block') return;
        const clipped = textPreview.scrollHeight > textPreview.clientHeight + 1;
        textNote.textContent = textWasTruncated || clipped
          ? 'Showing an excerpt. Open full text to read more.' : '';
        textNote.style.display = textWasTruncated || clipped ? 'block' : 'none';
      }
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
      new ResizeObserver(() => { layoutImage(); updateTextNote(); sizeChanged(); }).observe(frame);
      window.addEventListener('resize', () => { clearGestures(); layoutImage(); updateTextNote(); sizeChanged(); });
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
      function enableExternalLink(anchor, kind) {
        anchor.addEventListener('click', (event) => {
        const url = anchor.href;
        if (!validUrl(url, kind)) { event.preventDefault(); return; }
        if (window.openai?.openExternal) {
          event.preventDefault();
          Promise.resolve(window.openai.openExternal({ href: url, redirectUrl: false }))
            .catch(() => request('ui/open-link', { url }).catch(() => {
              status.style.display = '';
              status.textContent = 'Could not open the link. Use the URL from the tool response.';
              sizeChanged();
            }));
        } else {
          event.preventDefault();
          request('ui/open-link', { url }).catch(() => {
            status.style.display = '';
            status.textContent = 'Could not open the link. Use the URL from the tool response.';
            sizeChanged();
          });
        }
        });
      }
      enableExternalLink(link, 'download');
      enableExternalLink(fullLink, 'preview');
      enableExternalLink(imageLink, 'preview');
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
        clearGestures();
        zoom = 1; offsetX = 0; offsetY = 0;
        baseWidth = 0; baseHeight = 0;
        filename.textContent = typeof value.filename === 'string' ? value.filename : 'Published file';
        filename.style.display = 'block';
        link.href = downloadUrl;
        link.textContent = 'Download file';
        link.style.display = 'block';
        picture.style.display = 'none';
        reset.style.display = 'none';
        imageLink.style.display = 'none';
        details.style.display = 'none';
        textPreview.style.display = 'none';
        textNote.style.display = 'none';
        fullLink.style.display = 'none';
        const fullTextUrl = value.text_url;
        if (validUrl(fullTextUrl, 'preview') &&
            new URL(fullTextUrl).origin === new URL(downloadUrl).origin &&
            fullTextUrl.split('/').at(-1) === downloadUrl.split('/').at(-1) &&
            typeof value.text_preview === 'string') {
          image.removeAttribute('src');
          textPreview.textContent = value.text_preview;
          textWasTruncated = !!value.text_truncated;
          textPreview.style.display = 'block';
          updateTextNote();
          fullLink.href = fullTextUrl;
          fullLink.style.display = 'block';
          status.style.display = 'none';
          sizeChanged();
          return;
        }
        const previewUrl = value.preview_url;
        if (!validUrl(previewUrl, 'preview') ||
            new URL(previewUrl).origin !== new URL(downloadUrl).origin ||
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
          imageLink.href = previewUrl;
          imageLink.style.display = 'inline';
          status.style.display = 'none';
          details.textContent = image.naturalWidth + ' × ' + image.naturalHeight;
          details.style.display = 'block';
          layoutImage();
          sizeChanged();
        };
        image.onerror = () => {
          picture.style.display = 'none';
          imageLink.style.display = 'none';
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
