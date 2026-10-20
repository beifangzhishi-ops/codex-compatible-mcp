import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PUBLISHED_FILE_UI_HTML } from '../src/ui/published-file-app.mjs';

const downloadUrl = 'https://example.test/ccm/download/12345678-1234-4234-8234-123456789abc';
const previewUrl = 'https://example.test/ccm/preview/12345678-1234-4234-8234-123456789abc';
const fullTextUrl = 'https://example.test/ccm/preview/12345678-1234-4234-8234-123456789abc';

function mountCard() {
  const elements = Object.fromEntries(
    ['frame', 'filename', 'picture', 'image', 'image-link',
      'text-preview', 'text-note', 'status', 'details', 'link', 'full-link']
      .map((name) => [name, {
        style: {},
        textContent: '',
        href: '',
        clientHeight: 100,
        scrollHeight: 100,
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

test('published image has a browser preview link and fitted image in the same card', () => {
  const card = mountCard();
  card.result({
    capability: 'publish_worker_file',
    download_url: downloadUrl,
    preview_url: previewUrl,
    filename: 'portrait.png',
    mime_type: 'image/png',
  });
  assert.equal(card.elements.image.src, previewUrl);
  assert.equal(card.elements['image-link'].href, previewUrl);
  assert.equal(card.elements['image-link'].style.display, 'block');
  let prevented = false;
  card.elements['image-link'].click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(card.opened[0].href, previewUrl);
  assert.equal(card.opened[0].redirectUrl, false);
  card.elements.image.naturalWidth = 420;
  card.elements.image.naturalHeight = 1260;
  card.elements.image.onload();
  assert.equal(card.elements.picture.style.display, 'block');
  assert.equal(card.elements.details.style.display, 'block');
  assert.match(card.elements.details.textContent, /420 × 1260/);
  assert.match(PUBLISHED_FILE_UI_HTML, /max-height:\s*520px; object-fit:\s*contain/);
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

test('image preview link rejects foreign origins and is hidden after switching to text', () => {
  const card = mountCard();
  const badUrl = 'https://other.example/ccm/preview/12345678-1234-4234-8234-123456789abc';
  card.result({ capability: 'publish_worker_file',
    download_url: downloadUrl.replace('12345678-', '87654321-'),
    preview_url: badUrl, filename: 'untrusted.png' });
  assert.equal(card.elements.image.src, '');
  assert.equal(card.elements['image-link'].style.display, 'none');
  card.result({ capability: 'publish_worker_file', download_url: downloadUrl,
    preview_url: previewUrl, filename: 'photo.png' });
  card.elements['image-link'].click({ preventDefault() {} });
  assert.equal(card.opened.at(-1).href, previewUrl);
  card.result({ capability: 'publish_worker_file',
    download_url: downloadUrl.replace('12345678-', '87654321-'),
    text_url: fullTextUrl.replace('12345678-', '87654321-'),
    text_preview: 'safe', text_truncated: false });
  assert.equal(card.elements.picture.style.display, 'none');
  assert.equal(card.elements['image-link'].style.display, 'none');
});

test('image preview URL remains available if inline image fails to load', () => {
  const card = mountCard();
  card.result({ capability: 'publish_worker_file', download_url: downloadUrl,
    preview_url: previewUrl, filename: 'photo.png' });
  card.elements.image.onerror();
  assert.equal(card.elements.picture.style.display, 'none');
  assert.equal(card.elements['image-link'].href, previewUrl);
  assert.equal(card.elements['image-link'].style.display, 'block');
  assert.match(card.elements.status.textContent, /View image/);
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
