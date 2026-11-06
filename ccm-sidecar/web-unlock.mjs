import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CcmTotpManager } from './totp.mjs';

export const WEB_UNLOCK_PATH = '/ccm/unlock';
const PAIR_COOKIE = '__Secure-ccm-web-pair';
const CSRF_COOKIE = '__Secure-ccm-web-csrf';
const COPY_SCRIPT = `
const copyButton = document.getElementById('copy-grant');
if (copyButton) {
  copyButton.addEventListener('click', async () => {
    if (copyButton.disabled) return;
    copyButton.disabled = true;
    try {
      await navigator.clipboard.writeText(copyButton.dataset.copy);
    } catch {
      copyButton.textContent = '复制失败，请重试';
      copyButton.disabled = false;
      return;
    }
    try {
      const result = await fetch('/ccm/unlock', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'claim', csrf: copyButton.dataset.csrf, grant_id: copyButton.dataset.grantId,
        }),
      });
      if (!result.ok) throw new Error('Claim failed');
      window.location.replace('/ccm/unlock');
    } catch {
      copyButton.textContent = '已复制，但领取确认失败；请重试';
      copyButton.disabled = false;
    }
  });
}
`;
const PAIR_TTL_MS = 90 * 24 * 60 * 60_000;
const MAX_PAIRED_BROWSERS = 8;
const DURATIONS = [
  [60, '1 分钟'], [300, '5 分钟'], [1800, '30 分钟'],
  [3600, '1 小时'], [21600, '6 小时'],
  [86400, '1 天'], [604800, '7 天'],
];

const token = () => randomBytes(32).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('hex');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function cookiesFrom(value) {
  const result = {};
  for (const part of String(value || '').split(';')) {
    const equal = part.indexOf('=');
    if (equal > 0) result[part.slice(0, equal).trim()] = part.slice(equal + 1).trim();
  }
  return result;
}
function escape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function responseHtml(response, status, html, setCookies = []) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${createHash('sha256').update(COPY_SCRIPT).digest('base64')}'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}),
  });
  response.end(html);
}
function cookie(name, value, seconds) {
  return `${name}=${value}; Path=${WEB_UNLOCK_PATH}; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Lax`;
}
function redirect(response, query, setCookies = []) {
  response.writeHead(303, {
    Location: WEB_UNLOCK_PATH + query,
    'Cache-Control': 'no-store',
    ...(setCookies.length ? { 'Set-Cookie': setCookies } : {}),
  });
  response.end();
}

function renderPage({ paired, csrf, grant, message = '', error = false, configured = true }) {
  const pending = paired && grant?.pending;
  const grantId = pending ? grant.full_access_grant_id : null;
  const grantMessage = grantId
    ? `CCM 全权限句柄 full_access_grant_id：${grantId}。网页完成复制领取并回到解锁页后，请在需要全权限的 CCM 工具调用中直接使用此参数。`
    : '';
  const grantContent = pending
    ? `<p class="notice" role="status">全权限待领取，有效期至 ${escape(grant.expires_at)}。复制成功后完成领取并返回解锁页面。</p>
       <p class="copy-text" id="grant-id">${escape(grantId)}</p>
       <button type="button" id="copy-grant" data-copy="${escape(grantMessage)}" data-csrf="${escape(csrf)}" data-grant-id="${escape(grantId)}">一键复制并领取全权限句柄</button>
       <p class="muted">不复制时，可直接让 ChatGPT 调用领取工具。复制领取后如消息被拦截，工具仍可在原领取窗口内找回同一份句柄一次，不会续期。</p>`
    : '';
  const form = !configured
    ? '<p>CCM 手机验证器尚未在本机初始化并确认。请先按照 README 的步骤在 6v 本机终端完成配对。</p>'
    : pending
      ? ''
    : paired
      ? `<form method="post" action="${WEB_UNLOCK_PATH}">
          <input type="hidden" name="csrf" value="${escape(csrf)}">
          <input type="hidden" name="action" value="unlock">
          <label for="duration">授权时长</label>
          <select id="duration" name="duration_seconds">${DURATIONS.map(([s, name]) =>
            `<option value="${s}"${s === 21600 ? ' selected' : ''}>${name}</option>`).join('')}</select>
          <button type="submit">临时解锁 CCM</button>
        </form>`
      : `<p class="muted">此浏览器首次使用，需要手机验证器的一次性验证码。之后直接点击即可解锁。</p>
        <form method="post" action="${WEB_UNLOCK_PATH}">
          <input type="hidden" name="csrf" value="${escape(csrf)}">
          <input type="hidden" name="action" value="pair">
          <label for="code">手机验证码</label>
          <input id="code" name="code" type="text" inputmode="numeric"
            autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
          <button type="submit">配对此浏览器</button>
        </form>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>CCM 临时解锁</title><style>
    :root{color-scheme:light dark;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
    body{max-width:460px;margin:9vh auto;padding:0 20px;line-height:1.6}
    h1{font-size:1.55rem;margin:0 0 12px}.muted{opacity:.72;font-size:.9rem}
    .panel{padding:26px 20px;border:1px solid #8886;border-radius:16px}
    form{display:grid;gap:12px;margin-top:20px}label{font-weight:600}
    input,select,button{box-sizing:border-box;padding:13px;font:inherit;border-radius:9px;width:100%}
    button{border:0;background:#2764d7;color:white;font-weight:650;cursor:pointer;margin-top:8px}
    .notice{padding:10px 12px;border-radius:8px;background:#568a7a22}.error{background:#d65b5b26}
    .copy-text{padding:12px;border:1px solid #8886;border-radius:8px;user-select:all;overflow-wrap:anywhere}
    </style></head><body><main class="panel"><h1>CCM 临时解锁</h1>
    <p class="muted">全局授权 · 适用于所有 CCM Worker · 网页直接签发</p>
    ${message ? `<p class="notice${error ? ' error' : ''}" role="status">${escape(message)}</p>` : ''}
    ${grantContent}${form}
    ${!pending ? '<p class="muted">解锁后点击复制即领取；页面会恢复锁定，已领取句柄仍按原有效期可用。</p>' : ''}
    </main><script>${COPY_SCRIPT}</script></body></html>`;
}

export class CcmWebUnlock {
  constructor({
    stateFile = path.resolve(process.cwd(), '.state', 'ccm-web-browsers.json'),
    totp = new CcmTotpManager(),
    secret,
    bridge = null,
    now = () => Date.now(),
  } = {}) {
    this.stateFile = stateFile;
    this.totp = totp;
    this.secret = secret;
    this.now = now;
    this.bridge = bridge || (async (action, value) => {
      const reply = await fetch('http://127.0.0.1:18209/ccm/internal/web-unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CCM-Unlock-Bridge': secret,
        },
        body: JSON.stringify({ action, duration_seconds: action === 'issue' ? value : undefined, grant_id: action === 'claim' ? value : undefined }),
        signal: AbortSignal.timeout(3000),
      });
      if (action === 'claim' && reply.status === 409) return null;
      if (!reply.ok) throw new Error('CCM Controller unlock bridge unavailable.');
      return reply.json();
    });
  }
  isConfigured() {
    return fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'CCM', 'secrets', 'confirmed.flag'));
  }
  loadPairs() {
    try {
      const records = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (!Array.isArray(records) || records.length > 100) throw new Error('Invalid CCM browser pairing state.');
      return records.filter((p) => /^[a-f0-9]{64}$/.test(p.hash) && Number.isSafeInteger(p.expires));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  savePairs(pairs) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temp = this.stateFile + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(temp, JSON.stringify(pairs), { mode: 0o600 });
      fs.renameSync(temp, this.stateFile);
    } finally {
      try { fs.unlinkSync(temp); } catch {}
    }
  }
  isPaired(value) {
    if (!this.isConfigured() || typeof value !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    return this.loadPairs().some((p) => p.hash === hash(value) && p.expires > this.now());
  }
  pair(code) {
    if (!this.isConfigured() || !this.totp.verify(code)) return null;
    const value = token();
    const pairs = this.loadPairs().filter((p) => p.expires > this.now());
    pairs.push({ hash: hash(value), expires: this.now() + PAIR_TTL_MS });
    this.savePairs(pairs.slice(-MAX_PAIRED_BROWSERS));
    return value;
  }
  async handleHttp(request, response, readBody) {
    const cookies = cookiesFrom(request.headers.cookie);
    const paired = this.isPaired(cookies[PAIR_COOKIE]);
    const configured = this.isConfigured();
    if (request.method === 'GET') {
      const csrf = token();
      const info = configured && paired ? await this.bridge('status') : { active: false };
      const query = new URL(request.url, 'http://localhost').searchParams;
      const message = paired && !info.pending && query.has('paired')
        ? '浏览器配对成功。现在可以点击临时解锁。' : '';
      responseHtml(response, 200, renderPage({
        paired, csrf, configured, grant: info, message,
      }), [cookie(CSRF_COOKIE, csrf, 3600)]);
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'GET, POST' });
      response.end();
      return;
    }
    if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
      responseHtml(response, 415, 'Unsupported Media Type');
      return;
    }
    const body = new URLSearchParams(await readBody(request, 4096));
    if (!cookies[CSRF_COOKIE] || !safeEqual(cookies[CSRF_COOKIE], body.get('csrf'))) {
      responseHtml(response, 403, renderPage({
        paired: false, csrf: '', configured,
        message: '表单已失效，请刷新重试。', error: true,
      }));
      return;
    }
    if (body.get('action') === 'pair' && !paired && configured) {
      const value = this.pair(body.get('code'));
      if (!value) {
        responseHtml(response, 403, renderPage({
          paired: false, csrf: '', configured,
          message: '验证码无效或已使用，请刷新重试。', error: true,
        }));
        return;
      }
      redirect(response, '?paired=1', [cookie(PAIR_COOKIE, value, PAIR_TTL_MS / 1000)]);
      return;
    }
    if (body.get('action') === 'unlock' && paired) {
      const seconds = Number(body.get('duration_seconds'));
      if (!DURATIONS.some(([s]) => s === seconds)) {
        responseHtml(response, 400, renderPage({
          paired: true, csrf: '', configured,
          message: '无效的授权时长，请刷新重试。', error: true,
        }));
        return;
      }
      await this.bridge('issue', seconds);
      redirect(response, '');
      return;
    }
    if (body.get('action') === 'claim' && paired && configured) {
      const expectedId = body.get('grant_id');
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(expectedId || '')) {
        responseHtml(response, 400, 'Invalid grant ID');
        return;
      }
      const claim = await this.bridge('claim', expectedId);
      if (claim?.full_access_grant_id !== expectedId) {
        responseHtml(response, 409, 'Grant was already claimed or expired');
        return;
      }
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    responseHtml(response, 403, renderPage({
      paired: false, csrf: '', configured,
      message: '请先配对浏览器。', error: true,
    }));
  }
}
