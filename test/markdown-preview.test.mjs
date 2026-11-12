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

test('Markdown renders dollar and bracket math as self-contained MathML', () => {
  const source = [
    'Inline $E=mc^2$.',
    '',
    '$$',
    '\\frac{a}{b}',
    '$$',
    '',
    'Bracket inline \\(x+y\\) and display:',
    '',
    '\\[',
    '\\int_0^1 x\\,dx',
    '\\]',
  ].join('\n');
  const html = renderMarkdownFragment(source);
  assert.equal((html.match(/<math(?:\s|>)/g) || []).length, 4);
  assert.doesNotMatch(html, /<script|<iframe|https:\/\/cdn/i);
  assert.match(renderMarkdownDocument(source), /katex-display/);
});

test('Markdown keeps code math literal and flags malformed formulas without unsafe HTML', () => {
  const source = [
    'Inline code: ' + String.fromCharCode(96) + '$not_math$' + String.fromCharCode(96),
    '',
    '~~~md',
    '$not_math$',
    '~~~',
    '',
    'Wrong formula $\\definitelyNotACommand$',
    '',
    'Unsafe formula $\\href{javascript:alert(1)}{x}$',
  ].join('\n');
  const html = renderMarkdownFragment(source);
  assert.equal((html.match(/<math(?:\s|>)/g) || []).length, 2);
  assert.match(html, /mathcolor="#cc0000"/);
  assert.doesNotMatch(html, /<script|href="javascript:/i);
});