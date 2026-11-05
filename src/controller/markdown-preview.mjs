import MarkdownIt from 'markdown-it';

// Render untrusted Markdown without embedded HTML, scripts, or remote image loads.
// The outer browser preview also runs inside a restrictive CSP sandbox.
const markdown = new MarkdownIt({ html: false, linkify: false, maxNesting: 32 });
markdown.renderer.rules.image = (tokens, index) =>
  '<span class="markdown-image">[Image: ' +
  markdown.utils.escapeHtml(tokens[index].content) + ']</span>';

const STYLES = `
  :root { color-scheme: light dark; }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 24px 20px 64px; background: Canvas; color: CanvasText;
    font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif; }
  article { max-width: 880px; margin: 0 auto; overflow-wrap: anywhere; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.5em 0 .6em; }
  h1, h2 { border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, transparent);
    padding-bottom: .3em; }
  h1 { font-size: 1.85em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
  p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
  li { margin: .15em 0; } li > p { margin-bottom: .3em; }
  blockquote { margin-left: 0; padding: .2em 1em; border-left: 3px solid #888;
    color: color-mix(in srgb, CanvasText 75%, Canvas); }
  a { color: LinkText; } hr { border: 0; border-top: 1px solid #8886; }
  code, pre { font-family: ui-monospace, Consolas, "Cascadia Code", monospace; }
  code { font-size: .9em; background: color-mix(in srgb, CanvasText 8%, Canvas);
    border-radius: 4px; padding: .1em .3em; }
  pre { overflow: auto; padding: 14px; border-radius: 7px;
    background: color-mix(in srgb, CanvasText 8%, Canvas); }
  pre code { padding: 0; background: none; }
  table { border-collapse: collapse; display: block; width: max-content;
    max-width: 100%; overflow-x: auto; }
  th, td { border: 1px solid #8886; padding: 6px 12px; text-align: left; }
  th { background: color-mix(in srgb, CanvasText 6%, Canvas); }
  .markdown-image { font-style: italic; opacity: .7; }
  @media (max-width: 600px) { body { padding: 12px 14px 40px; font-size: 15px; } }
`;

export function renderMarkdownFragment(source) {
  return markdown.render(source);
}

export function renderMarkdownDocument(source, title = 'Markdown preview') {
  const safeTitle = markdown.utils.escapeHtml(title);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + safeTitle + '</title><style>' + STYLES + '</style></head>' +
    '<body><article>' + renderMarkdownFragment(source) + '</article></body></html>';
}
