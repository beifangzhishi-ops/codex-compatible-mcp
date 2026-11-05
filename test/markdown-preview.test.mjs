import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownFragment, renderMarkdownDocument } from '../src/controller/markdown-preview.mjs';

test('Markdown renders headings, tables, lists, code fences, and inline emphasis', () => {
  const html = renderMarkdownFragment('# Title\n\n| A | B |\n|---|---|\n|1|2|\n\n- **bold**\n\n```js\nconst x = 1\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<pre><code class="language-js">const x = 1/);
  const page = renderMarkdownDocument('# Title', 'unsafe <title>');
  assert.match(page, /<!doctype html>/);
  assert.match(page, /<title>unsafe &lt;title&gt;<\/title>/);
  assert.match(page, /<article><h1>Title<\/h1>/);
});

test('Markdown escapes HTML and disallows script URLs and external image requests', () => {
  const html = renderMarkdownFragment([
    '# <script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '[evil](javascript:alert(1))',
    '![remote](https://example.test/image.png)',
    '[safe](https://example.test/doc)',
  ].join('\n\n'));
  assert.doesNotMatch(html, /<script|<img|<[^>]*onerror=|href="javascript:|src="https:/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /\[Image: remote\]/);
  assert.match(html, /href="https:\/\/example\.test\/doc"/);
});
