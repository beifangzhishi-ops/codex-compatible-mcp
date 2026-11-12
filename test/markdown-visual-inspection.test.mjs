import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMarkdownRender } from '../src/controller/markdown-visual-inspection.mjs';

test('oversized Markdown reports visual review unavailable rather than claiming success', async () => {
  const output = await inspectMarkdownRender('x'.repeat(2 * 1024 * 1024 + 1));
  assert.equal(output.inspection.status, 'unavailable');
  assert.equal(output.inspection.visual_review_required, true);
  assert.equal(output.screenshots.length, 0);
});

test('installed headless browser produces actual formula screenshots and parser diagnostics', {
  skip: process.env.CCM_RUN_PUBLISH_VISUAL_TEST !== '1',
}, async () => {
  const valid = [
    '# Published formula',
    '',
    'Inline $E=mc^2$',
    '',
    '$$',
    '\\int_{-\\infty}^{\\infty}e^{-x^2}\\,dx=\\sqrt{\\pi}',
    '$$',
  ].join('\n');
  const good = await inspectMarkdownRender(valid, 'formula.md');
  assert.equal(good.inspection.status, 'automated_checks_passed', JSON.stringify(good.inspection));
  assert.equal(good.inspection.formula_error_count, 0);
  assert.ok(good.inspection.formula_count >= 2);
  assert.ok(good.screenshots.length >= 1);
  assert.equal(good.screenshots[0].mimeType, 'image/jpeg');
  assert.ok(Buffer.from(good.screenshots[0].data, 'base64').length > 1000);

  const bad = await inspectMarkdownRender('Invalid $\\definitelyNotACommand$', 'bad.md');
  assert.equal(bad.inspection.status, 'warning', JSON.stringify(bad.inspection));
  assert.ok(bad.inspection.formula_error_count >= 1);
  assert.ok(bad.screenshots.length >= 1);
});