import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PUBLISHED_FILE_UI_HTML, PUBLISHED_FILE_UI_URI } from '../src/ui/published-file-app.mjs';

const downloadUrl = 'https://example.test/ccm/download/12345678-1234-4234-8234-123456789abc';
const previewUrl = 'https://example.test/ccm/preview/12345678-1234-4234-8234-123456789abc';
const fullTextUrl = 'https://example.test/ccm/preview/12345678-1234-4234-8234-123456789abc';

function mountCard() {
  const elements = Object.fromEntries(
    ['frame', 'filename', 'picture', 'image', 'image-link', 'preview-link', 'text-preview', 'markdown-preview', 'text-note', 'status', 'details', 'link', 'full-link']
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
    capability: 'publish',
    download_url: downloadUrl,
    filename: 'results.pptx',
    mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  });
  assert.equal(card.elements.filename.textContent, 'results.pptx');
  assert.equal(card.elements.picture.style.display, 'none');
  assert.equal(card.elements['image-link'].style.display, 'none');
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
    capability: 'publish',
    download_url: downloadUrl,
    preview_url: previewUrl,
    filename: 'portrait.png',
    mime_type: 'image/png',
    preview_kind: 'image',
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
  assert.equal(card.elements.link.href, downloadUrl);
  assert.ok(card.notifications.some((x) => x.method === 'ui/notifications/size-changed'));
});

test('published text has a scrollable fixed-height snippet, full view and download', () => {
  const card = mountCard();
  card.result({
    capability: 'publish',
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
  assert.equal(card.elements['image-link'].style.display, 'none');
  let prevented = false;
  card.elements['full-link'].click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(card.opened[0].href, fullTextUrl);
  assert.match(PUBLISHED_FILE_UI_HTML, /height:\s*220px/);
  assert.match(PUBLISHED_FILE_UI_HTML, /overflow:\s*auto/);
});

test('published Markdown displays formatted snippet, full preview link and original download', () => {
  const card = mountCard();
  card.result({
    capability: 'publish', download_url: downloadUrl, preview_url: previewUrl,
    preview_kind: 'markdown', markdown_preview: '<h1>计划</h1><table><tr><td>Done</td></tr></table>',
    markdown_truncated: true, filename: 'plan.md',
  });
  assert.match(card.elements['markdown-preview'].innerHTML, /<h1>计划<\/h1>/);
  assert.equal(card.elements['markdown-preview'].style.display, 'block');
  assert.equal(card.elements['text-preview'].style.display, 'none');
  assert.equal(card.elements['full-link'].href, previewUrl);
  assert.equal(card.elements['full-link'].textContent, 'View full Markdown');
  assert.equal(card.elements.link.href, downloadUrl);
  assert.match(card.elements['text-note'].textContent, /beginning/);
  assert.match(PUBLISHED_FILE_UI_HTML, /height:\s*260px/);
  let prevented = false;
  card.elements['full-link'].click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(card.opened[0].href, previewUrl);
});

test('Markdown card does not accept mismatched preview links', () => {
  const card = mountCard();
  card.result({
    capability: 'publish', download_url: downloadUrl,
    preview_url: 'https://example.test/ccm/preview/87654321-1234-4234-8234-123456789abc',
    preview_kind: 'markdown', markdown_preview: '<h1>not trusted</h1>',
  });
  assert.equal(card.elements['markdown-preview'].style.display, 'none');
  assert.equal(card.elements['full-link'].style.display, 'none');
  assert.equal(card.elements.link.href, downloadUrl);
});

test('image preview link requires matching origin and token', () => {
  const invalidLinks = [
    'https://other.test/ccm/preview/12345678-1234-4234-8234-123456789abc',
    'https://example.test/ccm/preview/87654321-1234-4234-8234-123456789abc',
  ];
  for (const url of invalidLinks) {
    const card = mountCard();
    card.result({
      capability: 'publish',
      download_url: downloadUrl,
      preview_url: url,
      filename: 'photo.png',
      preview_kind: 'image',
    });
    assert.equal(card.elements['image-link'].style.display, 'none');
  }
});

test('image preview link survives thumbnail loading failure', () => {
  const card = mountCard();
  card.result({
    capability: 'publish',
    download_url: downloadUrl,
    preview_url: previewUrl,
    preview_kind: 'image',
    filename: 'photo.png',
  });
  card.elements.image.onerror();
  assert.equal(card.elements['image-link'].href, previewUrl);
  assert.equal(card.elements['image-link'].style.display, 'block');
});

test('text preview rejects foreign/mismatched full-text links', () => {
  const card = mountCard();
  card.result({
    capability: 'publish',
    download_url: downloadUrl,
    text_url: 'https://evil.example/ccm/text/12345678-1234-4234-8234-123456789abc',
    text_preview: 'should not render',
    filename: 'unsafe.txt',
  });
  assert.equal(card.elements['text-preview'].style.display, 'none');
  assert.equal(card.elements['full-link'].style.display, 'none');
});

test('PDF preview card retains its download link', () => {
  const card = mountCard();
  card.result({ capability: 'publish', download_url: downloadUrl,
    preview_url: previewUrl, preview_kind: 'document', filename: 'report.pdf' });
  assert.equal(card.elements['preview-link'].href, previewUrl);
  assert.equal(card.elements['preview-link'].textContent, 'View PDF');
  assert.equal(card.elements['preview-link'].style.display, 'block');
  assert.equal(card.elements.link.href, downloadUrl);
});

test('publish retains the stable mobile-compatible UI resource URI', () => {
  assert.equal(PUBLISHED_FILE_UI_URI, 'ui://ccm/published-file-v9.html');
});