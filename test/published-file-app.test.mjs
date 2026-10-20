import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PUBLISHED_FILE_UI_HTML } from '../src/ui/published-file-app.mjs';

const downloadUrl = 'https://example.test/ccm/download/12345678-1234-4234-8234-123456789abc';
const previewUrl = 'https://example.test/ccm/preview/12345678-1234-4234-8234-123456789abc';
const fullTextUrl = 'https://example.test/ccm/preview/12345678-1234-4234-8234-123456789abc';

function mountCard({ width = 400, mobile = true } = {}) {
  const elements = Object.fromEntries(
    ['frame', 'filename', 'picture', 'viewport', 'image', 'reset', 'image-link',
      'image-controls', 'text-preview', 'text-note', 'status', 'details', 'link', 'full-link']
      .map((name) => [name, {
        style: {},
        textContent: '',
        href: '',
        clientHeight: 100,
        scrollHeight: 100,
        capture: new Set(),
        setPointerCapture(id) { this.capture.add(id); },
        hasPointerCapture(id) { return this.capture.has(id); },
        releasePointerCapture(id) { this.capture.delete(id); },
        removeAttribute(attr) { if (attr === 'src') this.src = ''; },
        getBoundingClientRect() {
          return name === 'viewport'
            ? { left: 10, top: 20, width, height: Number.parseFloat(this.style.height) || 200 }
            : { height: 120, width };
        },
        addEventListener(event, callback, options) {
          this[event] = callback;
          if (event === 'wheel') this.wheelOptions = options;
        },
      }]),
  );
  const listeners = {};
  const opened = [];
  const notifications = [];
  const parent = { postMessage: (msg) => { notifications.push(msg); } };
  const window = {
    parent,
    matchMedia: () => ({ matches: mobile }),
    openai: {
      openExternal: (args) => { opened.push(args); return Promise.resolve(); },
      notifyIntrinsicHeight() {},
    },
    addEventListener: (event, callback) => { listeners[event] = callback; },
  };
  const script = PUBLISHED_FILE_UI_HTML.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    URL, Promise, window,
    document: {
      getElementById: (id) => elements[id],
      documentElement: { getBoundingClientRect: () => ({ width: 420 }) },
    },
    ResizeObserver: class { observe() {} },
    requestAnimationFrame: (callback) => callback(),
    setTimeout: () => 1,
    clearTimeout() {},
  });
  function result(structuredContent) {
    listeners.message({
      source: parent,
      data: {
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-result',
        params: { structuredContent },
      },
    });
  }
  function imageResult({ naturalWidth = 1200, naturalHeight = 600, url = previewUrl } = {}) {
    result({ capability: 'publish_worker_file', download_url: downloadUrl,
      preview_url: url, filename: 'photo.png', mime_type: 'image/png' });
    elements.image.naturalWidth = naturalWidth;
    elements.image.naturalHeight = naturalHeight;
    elements.image.onload?.();
  }
  function pointer(type, { id = 1, x = 210, y = 120, pointerType = 'touch', button = 0 } = {}) {
    let prevented = false;
    elements.viewport[type]({ pointerId: id, clientX: x, clientY: y,
      pointerType, button, preventDefault() { prevented = true; } });
    return prevented;
  }
  function wheel({ x = 210, y = 120, deltaY = -208, deltaMode = 0 } = {}) {
    let prevented = false;
    elements.viewport.wheel({ clientX: x, clientY: y, deltaY, deltaMode,
      preventDefault() { prevented = true; } });
    return prevented;
  }
  function transform() {
    const css = elements.image.style.transform;
    const values = css.match(/translate\(calc\(-50% \+ ([\d.e+-]+)px\), calc\(-50% \+ ([\d.e+-]+)px\)\) scale\(([\d.e+-]+)\)/);
    assert.ok(values, css);
    return { x: Number(values[1]), y: Number(values[2]), zoom: Number(values[3]) };
  }
  return { elements, opened, notifications, result, imageResult, pointer, wheel, transform, listeners };
}

test('published non-image displays filename and an externally opened download link without an image', () => {
  const card = mountCard();
  card.result({
    capability: 'publish_worker_file',
    download_url: downloadUrl,
    filename: 'results.pptx',
    mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  assert.equal(card.elements.filename.textContent, 'results.pptx');
  assert.equal(card.elements.picture.style.display, 'none');
  assert.equal(card.elements.status.style.display, 'none');
  assert.equal(card.elements.link.style.display, 'block');
  assert.equal(card.elements.link.href, downloadUrl);
  let prevented = false;
  card.elements.link.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(card.opened.length, 1);
  assert.equal(card.opened[0].href, downloadUrl);
  assert.equal(card.opened[0].redirectUrl, false);
});

test('published image shows fitted image and download link in the same card', () => {
  const card = mountCard();
  card.result({
    capability: 'publish_worker_file',
    download_url: downloadUrl,
    preview_url: previewUrl,
    filename: 'portrait.png',
    mime_type: 'image/png',
  });
  assert.equal(card.elements.image.src, previewUrl);
  card.elements.image.naturalWidth = 420;
  card.elements.image.naturalHeight = 1260;
  card.elements.image.onload();
  assert.equal(card.elements.picture.style.display, 'block');
  assert.equal(card.elements.details.style.display, 'block');
  assert.match(card.elements.details.textContent, /420 × 1260/);
  assert.equal(card.elements.viewport.style.height, '360px');
  assert.equal(card.elements.image.style.width, '120px');
  assert.equal(card.elements['image-link'].href, previewUrl);
  assert.equal(card.elements['reset'].style.display, 'none');
  assert.equal(card.elements.link.href, downloadUrl);
  assert.ok(card.notifications.some((x) => x.method === 'ui/notifications/size-changed'));
});

test('published text displays a bounded non-scrollable excerpt and external full view', () => {
  const card = mountCard();
  card.result({
    capability: 'publish_worker_file',
    download_url: downloadUrl,
    text_url: fullTextUrl,
    text_preview: '<h1>Hello</h1>\nline 2',
    text_truncated: true,
    filename: 'index.html',
    mime_type: 'text/html',
  });
  assert.equal(card.elements['text-preview'].textContent, '<h1>Hello</h1>\nline 2');
  assert.equal(card.elements['text-preview'].style.display, 'block');
  assert.equal(card.elements['full-link'].href, fullTextUrl);
  assert.equal(card.elements['full-link'].style.display, 'block');
  assert.equal(card.elements.link.href, downloadUrl);
  assert.match(card.elements['text-note'].textContent, /excerpt/);
  assert.equal(card.elements.picture.style.display, 'none');
  let prevented = false;
  card.elements['full-link'].click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(card.opened[0].href, fullTextUrl);
  assert.match(PUBLISHED_FILE_UI_HTML, /max-height:\s*220px/);
  assert.match(PUBLISHED_FILE_UI_HTML, /max-height:\s*220px; max-width:\s*100%; overflow:\s*hidden/);
});

test('short complete text hides excerpt hint; locally clipped content shows it', () => {
  const card = mountCard();
  const value = { capability: 'publish_worker_file', download_url: downloadUrl,
    text_url: fullTextUrl, text_preview: 'short', text_truncated: false };
  card.result(value);
  assert.equal(card.elements['text-note'].style.display, 'none');
  card.elements['text-preview'].scrollHeight = 400;
  card.result({ ...value, download_url: downloadUrl.replace('12345678-', '87654321-') ,
    text_url: fullTextUrl.replace('12345678-', '87654321-') });
  assert.match(card.elements['text-note'].textContent, /excerpt/);
});

test('pinch zoom follows midpoint and seamlessly switches to single finger pan', () => {
  const card = mountCard();
  card.imageResult();
  card.pointer('pointerdown', { id: 1, x: 170 });
  card.pointer('pointerdown', { id: 2, x: 250 });
  card.pointer('pointermove', { id: 2, x: 330 });
  const pinch = card.transform();
  assert.ok(Math.abs(pinch.zoom - 2) < 1e-8);
  assert.ok(Math.abs(pinch.x - 40) < 1e-8);
  assert.equal(card.elements.reset.style.display, 'inline-block');
  card.pointer('pointerup', { id: 2, x: 330 });
  card.pointer('pointermove', { id: 1, x: 190 });
  assert.ok(Math.abs(card.transform().x - 60) < 1e-8);
  card.pointer('pointercancel', { id: 1 });
  card.pointer('pointermove', { id: 1, x: 250 });
  assert.ok(Math.abs(card.transform().x - 60) < 1e-8);
  card.elements.reset.click();
  assert.deepEqual(card.transform(), { x: 0, y: 0, zoom: 1 });
});

test('wheel zoom is cursor-anchored with deltaMode conversion and bounded scale', () => {
  const card = mountCard();
  card.imageResult();
  assert.equal(card.elements.viewport.wheelOptions.passive, false);
  assert.equal(card.wheel({ x: 260, y: 140, deltaY: -300 * Math.log(2) }), true);
  const t = card.transform();
  assert.ok(Math.abs(t.zoom - 2) < 1e-8);
  assert.ok(Math.abs(t.x + 50) < 1e-8);
  assert.ok(Math.abs(t.y + 20) < 1e-8);
  card.wheel({ deltaY: -1000, deltaMode: 1 });
  assert.equal(card.transform().zoom, 6);
  card.wheel({ deltaY: 100, deltaMode: 2 });
  assert.equal(card.transform().zoom, 1);
  assert.deepEqual(card.transform(), { x: 0, y: 0, zoom: 1 });
});

test('middle mouse button pans and releases; other buttons do not pan', () => {
  const card = mountCard();
  card.imageResult();
  card.wheel({ deltaY: -300 * Math.log(2) });
  assert.equal(card.pointer('pointerdown', { pointerType: 'mouse', button: 1 }), true);
  assert.equal(card.elements.viewport.hasPointerCapture(1), true);
  card.pointer('pointermove', { pointerType: 'mouse', x: 250 });
  assert.equal(card.transform().x, 40);
  assert.equal(card.pointer('mousedown', { pointerType: 'mouse', button: 1 }), true);
  assert.equal(card.pointer('auxclick', { pointerType: 'mouse', button: 1 }), true);
  card.pointer('pointerup', { pointerType: 'mouse', button: 1 });
  card.pointer('pointermove', { pointerType: 'mouse', x: 300 });
  assert.equal(card.transform().x, 40);
  card.pointer('pointerdown', { pointerType: 'mouse', button: 0 });
  card.pointer('pointermove', { pointerType: 'mouse', x: 330 });
  assert.equal(card.transform().x, 40);
  card.pointer('pointerdown', { pointerType: 'mouse', button: 1 });
  card.pointer('lostpointercapture', { pointerType: 'mouse', button: 1 });
  card.pointer('pointermove', { pointerType: 'mouse', x: 350 });
  assert.equal(card.transform().x, 40);
});

test('panning clamps to image edges and small axes stay centered', () => {
  const card = mountCard();
  card.imageResult({ naturalWidth: 420, naturalHeight: 1260 });
  card.wheel({ deltaY: -300 * Math.log(2) });
  card.pointer('pointerdown', { id: 1 });
  card.pointer('pointermove', { id: 1, x: 999, y: 999 });
  const t = card.transform();
  assert.equal(t.x, 0);
  assert.ok(Math.abs(t.y - 180) < 1e-8);
});

test('image original URL rejects foreign origins and switches cleanly to text', () => {
  const card = mountCard();
  const badUrl = 'https://other.example/ccm/preview/12345678-1234-4234-8234-123456789abc';
  card.result({ capability: 'publish_worker_file',
    download_url: downloadUrl.replace('12345678-', '87654321-'),
    preview_url: badUrl, filename: 'untrusted.png' });
  assert.equal(card.elements.image.src, '');
  card.imageResult();
  card.wheel({ deltaY: -300 * Math.log(2) });
  card.elements['image-link'].click({ preventDefault() {} });
  assert.equal(card.opened.at(-1).href, previewUrl);
  card.result({ capability: 'publish_worker_file',
    download_url: downloadUrl.replace('12345678-', '87654321-'),
    text_url: fullTextUrl.replace('12345678-', '87654321-'),
    text_preview: 'safe', text_truncated: false });
  assert.equal(card.elements.picture.style.display, 'none');
  assert.equal(card.elements['image-link'].style.display, 'none');
  assert.equal(card.elements.reset.style.display, 'none');
});

test('text preview rejects foreign/mismatched full-text links', () => {
  const card = mountCard();
  card.result({
    capability: 'publish_worker_file',
    download_url: downloadUrl,
    text_url: 'https://evil.example/ccm/text/12345678-1234-4234-8234-123456789abc',
    text_preview: 'should not render',
    filename: 'unsafe.txt',
  });
  assert.equal(card.elements['text-preview'].style.display, 'none');
  assert.equal(card.elements['full-link'].style.display, 'none');
});
