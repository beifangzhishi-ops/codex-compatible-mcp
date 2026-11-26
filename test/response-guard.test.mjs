import test from 'node:test';
import assert from 'node:assert/strict';
import { guardMcpToolResult, usesEmbeddedImages } from '../src/controller/response-guard.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=', annotations: { audience: ['assistant'] }, _meta: { example: true } };
const result = { content: [{ type: 'text', text: 'screenshot' }, image, { ...image, mimeType: 'image/jpeg' }], structuredContent: { status: 'ok' }, _meta: { path: 'test' } };
const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('only the documented Google user agent selects embedded images', () => {
  for (const ua of ['Google', 'google', ' Google ']) assert.equal(usesEmbeddedImages(ua), true);
  for (const ua of [undefined, null, 'openai-mcp/1.0.0', 'Gemini', 'Googlebot', 'Google/1.0', 'Google, other']) {
    assert.equal(usesEmbeddedImages(ua), false);
    assert.equal(guardMcpToolResult(result, 65536, 1000000, ua), result);
  }
});

test('Google adaptation preserves image bytes, metadata, content order and other result fields', () => {
  const adapted = guardMcpToolResult(result, 65536, 1000000, 'Google');
  assert.deepEqual(adapted.structuredContent, result.structuredContent);
  assert.deepEqual(adapted._meta, result._meta);
  assert.equal(adapted.content[0], result.content[0]);
  for (let i = 1; i < adapted.content.length; i++) {
    const { resource, ...block } = adapted.content[i];
    assert.deepEqual(block, { type: 'resource', annotations: image.annotations, _meta: image._meta });
    assert.equal(resource.blob, result.content[i].data);
    assert.equal(resource.mimeType, result.content[i].mimeType);
    assert.match(resource.uri, /^urn:ccm:image:/);
  }
  assert.notEqual(adapted.content[1].resource.uri, adapted.content[2].resource.uri);
  assert.equal(result.content[1].type, 'image');
  const textOnly = { content: [result.content[0]] };
  assert.equal(guardMcpToolResult(textOnly, 65536, 1000000, 'Google'), textOnly);
});

test('converted images never obtain the embedded-file size allowance', () => {
  const originalSize = size(result);
  for (const limit of [originalSize - 1, originalSize]) {
    const blocked = guardMcpToolResult(result, limit, 1000000, 'Google');
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /blocked oversized tool result/);
  }
  assert.equal(guardMcpToolResult(result, originalSize, 1000000, 'openai-mcp/1.0.0'), result);
  const file = { type: 'resource', resource: { uri: 'urn:ccm:existing-file', mimeType: 'application/octet-stream', blob: 'AA==' } };
  const fileResult = { content: [file, image] };
  const adapted = guardMcpToolResult(fileResult, 1, 1000000, 'Google');
  assert.equal(adapted.content[0], file);
  assert.equal(adapted.content[1].resource.blob, image.data);
  assert.equal(guardMcpToolResult(fileResult, 1, size(fileResult), 'Google').isError, true);
});
