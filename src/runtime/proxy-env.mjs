import { spawnSync } from 'node:child_process';

const WINDOWS_INTERNET_SETTINGS =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';

function enabled(value) {
  if (value == null || value === '') return true;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function normalizeProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return 'http://' + raw;
}

function parseProxyServer(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (!raw.includes('=')) return normalizeProxyUrl(raw);

  const entries = new Map();
  for (const part of raw.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 1) continue;
    entries.set(
      part.slice(0, equals).trim().toLowerCase(),
      part.slice(equals + 1).trim(),
    );
  }
  return normalizeProxyUrl(
    entries.get('https') ||
    entries.get('http') ||
    entries.get('socks') ||
    '',
  );
}

function queryWindowsProxy(env = process.env, spawn = spawnSync) {
  if (process.platform !== 'win32' && !env.CCM_PROXY_TEST_WINDOWS) return null;

  try {
    const result = spawn(
      'reg.exe',
      ['query', WINDOWS_INTERNET_SETTINGS, '/v', 'ProxyEnable'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(result.stdout || '')) {
      return null;
    }

    const server = spawn(
      'reg.exe',
      ['query', WINDOWS_INTERNET_SETTINGS, '/v', 'ProxyServer'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (server.status !== 0) return null;
    const match = String(server.stdout || '').match(/ProxyServer\s+REG_SZ\s+(.+)$/im);
    return parseProxyServer(match?.[1]);
  } catch {
    return null;
  }
}

export function discoverProxyUrl(env = process.env, spawn = spawnSync) {
  if (!enabled(env.CCM_PROXY_AUTO)) return null;

  const explicit =
    env.CCM_PROXY ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy;
  if (explicit) return normalizeProxyUrl(explicit);

  return queryWindowsProxy(env, spawn);
}

export function buildProxyEnvironment(env = process.env, spawn = spawnSync) {
  const proxy = discoverProxyUrl(env, spawn);
  if (!proxy) return { ...env };

  const noProxy = env.NO_PROXY || env.no_proxy || DEFAULT_NO_PROXY;
  return {
    ...env,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

export const proxyInternals = {
  normalizeProxyUrl,
  parseProxyServer,
};
