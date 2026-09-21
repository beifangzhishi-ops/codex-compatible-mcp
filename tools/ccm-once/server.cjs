const http = require('http');
const fs = require('fs');

const [token, secretFile, ttlRaw = '300'] = process.argv.slice(2);
const ttlMs = Math.max(10, Number(ttlRaw)) * 1000;
const deadline = Date.now() + ttlMs;
let used = false;

function page(body) {
  return '<!doctype html><meta name="viewport" content="width=device-width">' +
    '<meta name="referrer" content="no-referrer"><title>CCM one-time secret</title>' +
    '<style>body{font:16px system-ui;max-width:720px;margin:48px auto;padding:20px}' +
    'button{font-size:18px;padding:12px 18px}pre{white-space:pre-wrap;word-break:break-all;background:#eee;padding:16px}</style>' + body;
}

const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (Date.now() > deadline || used) {
    res.statusCode = 410;
    return res.end(page('<h2>Expired</h2>'));
  }
  const requestPath = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '');
  if (requestPath !== '/' + token && requestPath !== '/ccm-once/' + token) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(page('<h2>CCM one-time secret</h2><p>Reveal consumes this link.</p><form method="POST"><button>Reveal once</button></form>'));
  }
  if (req.method === 'POST') {
    used = true;
    let secret = fs.readFileSync(secretFile, 'utf8').trim();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page('<h2>Copy now</h2><pre id="s"></pre><button onclick="navigator.clipboard.writeText(document.getElementById(\'s\').textContent)">Copy</button><script>document.getElementById("s").textContent=' + JSON.stringify(secret) + '</script>'));
    secret = null;
    return setTimeout(() => server.close(() => process.exit(0)), 1500);
  }
  res.statusCode = 405;
  res.end('Method not allowed');
});

server.listen(18444, '127.0.0.1', () => console.log('READY'));
setTimeout(() => server.close(() => process.exit(0)), ttlMs + 5000);
