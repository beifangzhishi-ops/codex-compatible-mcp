import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PUBLISHED_FILE_UI_HTML } from '../src/ui/published-file-app.mjs';

const downloadUrl = 'https://example.test/ccm/download/12345678-1234-4234-8234-123456789abc';
const previewUrl = 'https://example.test/ccm/preview/12345678-1234-4234-8234-123456789abc';
const fullTextUrl = 'https://example.test/ccm/text/12345678-1234-4234-8234-123456789abc';

function mountCard() {
  const elements = Object.fromEntries(
    ['frame', 'filename', 'picture', 'image', 'text-preview', 'text-note', 'status', 'details', 'link', 'full-link']
      .map((name) => [name, {
        style: {},
        textContent: '',
        href: '',
        removeAttribute(attr) { if (attr === 'src') this.src = ''; },
        getBoundingClientRect() { return { height: 120 }; },
        addEventListener(event, callback) { this[event] = callback; },
      }]),
  );
  const listeners = {};
  const opened = [];
  const notifications = [];
  const parent = { postMessage: (msg) => { notifications.push(msg); } };
  const window = {
    parent,
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
  return { elements, opened, notifications, result };
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
  assert.equal(card.elements.link.href, downloadUrl);
  assert.ok(card.notifications.some((x) => x.method === 'ui/notifications/size-changed'));
});

test('published text has a scrollable fixed-height snippet, full view and download', () => {
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
  assert.match(card.elements['text-note'].textContent, /beginning/);
  assert.equal(card.elements.picture.style.display, 'none');
  let prevented = false;
  card.elements['full-link'].click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(card.opened[0].href, fullTextUrl);
  assert.match(PUBLISHED_FILE_UI_HTML, /height:\s*220px/);
  assert.match(PUBLISHED_FILE_UI_HTML, /overflow:\s*auto/);
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
