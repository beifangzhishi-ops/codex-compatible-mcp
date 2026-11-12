import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { renderMarkdownDocument } from './markdown-preview.mjs';

const MAX_INSPECT_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 900 * 1024;
const CAPTURE_WIDTH = 960;
const SLICE_HEIGHT = 760;

function systemBrowserPath() {
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

/**
 * Screenshots are model-facing MCP image content only, not a second public
 * file and not a screenshot of the ChatGPT-hosted App. They render the exact
 * HTML produced for the public Markdown preview, with remote requests blocked.
 */
export async function inspectMarkdownRender(source, filename = 'Markdown preview') {
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  let markupFormulaCount = 0;
  let markupErrorCount = 0;
  const unavailable = (reason) => ({
    inspection: {
      status: 'unavailable',
      source_bytes: sourceBytes,
      formula_count: markupFormulaCount,
      formula_error_count: markupErrorCount,
      message: String(reason).split('\n')[0].slice(0, 300),
      visual_review_required: true,
    },
    screenshots: [],
  });
  if (sourceBytes > MAX_INSPECT_SOURCE_BYTES) {
    return unavailable('Document exceeds the 2 MiB visual-inspection limit; full Markdown preview and download are still available.');
  }
  let previewHtml;
  try {
    previewHtml = renderMarkdownDocument(source, filename);
    markupFormulaCount = (previewHtml.match(/<math(?:\s|>)/g) || []).length;
    markupErrorCount = (previewHtml.match(/<mstyle mathcolor="#cc0000"/g) || []).length +
      (previewHtml.match(/class="katex-error"/g) || []).length;
  } catch (error) {
    return unavailable('Markdown render failed: ' + String(error?.message || error));
  }
  const executablePath = systemBrowserPath();
  if (!executablePath) return unavailable('No installed Chrome or Edge browser was found on the Controller.');

  let browser;
  try {
    browser = await chromium.launch({
      executablePath,
      headless: true,
      timeout: 20000,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking'],
    });
    const context = await browser.newContext({
      viewport: { width: CAPTURE_WIDTH, height: 820 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
    });
    const page = await context.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(previewHtml, { waitUntil: 'load', timeout: 20000 });
    const metrics = await page.evaluate(() => {
      const documentWidth = document.documentElement.clientWidth;
      const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const mathNodes = Array.from(document.querySelectorAll('.katex'));
      const invalid = Array.from(document.querySelectorAll('.katex-error, .katex mstyle[mathcolor="#cc0000"]'));
      const visibleY = (element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top + window.scrollY + bounds.height / 2;
      };
      const tableNodes = Array.from(document.querySelectorAll('table'));
      return {
        pageHeight: height,
        mathCount: mathNodes.length,
        mathYs: mathNodes.map(visibleY),
        tableYs: tableNodes.map(visibleY),
        errorCount: invalid.length,
        errors: invalid.slice(0, 8).map((element) =>
          String(element.getAttribute('title') || element.textContent || '').slice(0, 160)),
        horizontalOverflow: document.documentElement.scrollWidth > documentWidth + 2,
      };
    });
    const screenshots = [];
    const pageHeight = Math.max(1, Math.ceil(metrics.pageHeight));
    const capture = async (label, clip) => {
      const data = await page.screenshot({
        type: 'jpeg',
        quality: 76,
        animations: 'disabled',
        ...(clip ? { clip } : { fullPage: true }),
        timeout: 20000,
      });
      const bytes = screenshots.reduce((sum, item) => sum + item.data.length, 0);
      if (bytes + data.length <= MAX_SCREENSHOT_BYTES) screenshots.push({ label, data });
    };
    if (pageHeight <= 1500) {
      await capture('Complete rendered Markdown page', null);
    } else {
      const maxY = Math.max(0, pageHeight - SLICE_HEIGHT);
      const positions = [{ label: 'Beginning of rendered document', y: 0 }];
      const middleMath = metrics.mathYs[Math.floor(metrics.mathYs.length / 2)];
      const middleTable = metrics.tableYs[Math.floor(metrics.tableYs.length / 2)];
      if (middleMath != null) positions.push({ label: 'Representative rendered formula', y: middleMath - SLICE_HEIGHT / 2 });
      if (middleTable != null) positions.push({ label: 'Representative rendered table', y: middleTable - SLICE_HEIGHT / 2 });
      if (middleMath == null && middleTable == null) positions.push({ label: 'Middle of rendered document', y: pageHeight / 2 });
      positions.push({ label: 'End of rendered document', y: maxY });
      const capturedY = [];
      for (const position of positions) {
        const y = Math.round(Math.min(maxY, Math.max(0, position.y)));
        if (capturedY.some((existing) => Math.abs(y - existing) < 170)) continue;
        capturedY.push(y);
        await capture(position.label, { x: 0, y, width: CAPTURE_WIDTH, height: SLICE_HEIGHT });
      }
    }
    return {
      inspection: {
        status: screenshots.length === 0 ? 'unavailable' :
          metrics.errorCount || metrics.horizontalOverflow ? 'warning' : 'automated_checks_passed',
        source_bytes: sourceBytes,
        formula_count: metrics.mathCount,
        formula_error_count: metrics.errorCount,
        formula_errors: metrics.errors,
        horizontal_overflow: metrics.horizontalOverflow,
        rendered_height_px: pageHeight,
        screenshot_count: screenshots.length,
        screenshot_coverage: pageHeight <= 1500 ? 'complete_page' : 'representative_sections',
        visual_review_required: true,
      },
      screenshots: screenshots.map((item) => ({
        label: item.label,
        data: item.data.toString('base64'),
        mimeType: 'image/jpeg',
      })),
    };
  } catch (error) {
    return unavailable('Headless browser rendering failed: ' + String(error?.message || error));
  } finally {
    await browser?.close().catch(() => {});
  }
}