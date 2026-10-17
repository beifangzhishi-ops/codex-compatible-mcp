import test from 'node:test';
import assert from 'node:assert/strict';
import { INLINE_TEXT_LIMIT, isPreviewableTextMime, textPreviewFromBase64 } from '../src/controller/text-file-preview.mjs';

test('only known plain-text formats qualify for inline preview', () => {
  for (const type of ['text/plain', 'text/markdown', 'text/html', 'application/json',
    'application/ld+json', 'application/xml', 'application/vnd.api+json']) {
    assert.equal(isPreviewableTextMime(type), true, type);
  }
  for (const type of ['application/pdf', 'application/zip', 'image/png', 'application/octet-stream']) {
    assert.equal(isPreviewableTextMime(type), false, type);
  }
});

test('UTF-8 snippet is bounded and never splits a multibyte character', () => {
  const content = 'A'.repeat(INLINE_TEXT_LIMIT - 1) + '😀' + 'TAIL';
  const preview = textPreviewFromBase64(Buffer.from(content).toString('base64'), 'text/plain');
  assert.equal(preview.text, 'A'.repeat(INLINE_TEXT_LIMIT - 1));
  assert.equal(preview.truncated, true);
});

test('NUL and invalid UTF-8 are not embedded in the chat card', () => {
  assert.equal(textPreviewFromBase64(Buffer.from([65,0,66]).toString('base64'), 'text/plain'), null);
  assert.equal(textPreviewFromBase64(Buffer.from([0xff,0xfe]).toString('base64'), 'text/plain'), null);
  assert.equal(textPreviewFromBase64(Buffer.from('abc').toString('base64'), 'application/pdf'), null);
});
