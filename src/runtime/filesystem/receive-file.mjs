import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { discoverProxyUrl } from '../proxy-env.mjs';

export const DEFAULT_MAX_RECEIVE_FILE_BYTES = 512 * 1024 * 1024;
export const DEFAULT_RECEIVE_FILE_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_RECEIVE_FILE_TOTAL_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_RECEIVE_FILE_MAX_REDIRECTS = 5;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
     relative !== '..' &&
     !path.isAbsolute(relative));
}

function sanitizeFileName(value) {
  let name = path.basename(String(value || '').trim())
    .replace(/[\u0000-\u001f<>:"/\\|?*]/gu, '_')
    .replace(/[ .]+$/u, '');
  if (!name || name === '.' || name === '..') {
    throw new Error(
      'receive_file requires file.file_name when destination is omitted.',
    );
  }
  if (WINDOWS_RESERVED.test(name)) name = '_' + name;
  return name;
}

function ipv4Integer(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) ||
      part < 0 || part > 255)) return null;
  return (((parts[0] << 24) >>> 0) |
    (parts[1] << 16) |
    (parts[2] << 8) |
    parts[3]) >>> 0;
}

function ipv4InCidr(address, base, prefix) {
  const value = ipv4Integer(address);
  const baseValue = ipv4Integer(base);
  if (value == null || baseValue == null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function isPublicIpv4(address) {
  const blocked = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  return !blocked.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
}

function isPublicIpv6(address) {
  const normalized = String(address).toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (/^fe[89ab]/u.test(normalized)) return false;
  if (normalized.startsWith('ff')) return false;
  if (normalized.startsWith('2001:db8:')) return false;
  if (normalized.startsWith('::ffff:')) return false;
  return true;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function resolvePublicTarget(hostname, lookup = dns.lookup) {
  const literalFamily = net.isIP(hostname);
  const entries = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('receive_file could not resolve download host: ' + hostname);
  }
  for (const entry of entries) {
    if (!isPublicAddress(entry.address)) {
      throw new Error(
        'receive_file refuses non-public download target for host ' + hostname + '.',
      );
    }
  }
  return entries[0];
}

function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return null;
  const user = decodeURIComponent(proxy.username || '');
  const password = decodeURIComponent(proxy.password || '');
  return 'Basic ' + Buffer.from(user + ':' + password).toString('base64');
}

function hostHeader(url) {
  const defaultPort = url.protocol === 'https:' ? '443' : '80';
  return url.port && url.port !== defaultPort
    ? url.hostname + ':' + url.port
    : url.hostname;
}

function requestResponse(options, onRequest = null) {
  return new Promise((resolve, reject) => {
    const request = https.request(options, resolve);
    onRequest?.(request);
    request.on('error', reject);
    request.end();
  });
}

async function directHttpsResponse(url, resolved, {
  signal,
  connectTimeoutMs,
} = {}) {
  return requestResponse({
    protocol: 'https:',
    hostname: resolved.address,
    family: resolved.family,
    port: Number(url.port || 443),
    servername: url.hostname,
    method: 'GET',
    path: url.pathname + url.search,
    headers: {
      Host: hostHeader(url),
      Accept: '*/*',
      'User-Agent': 'CCM receive_file',
    },
    signal,
  }, (request) => {
    request.setTimeout(connectTimeoutMs, () => {
      request.destroy(new Error('receive_file download connection timed out.'));
    });
  });
}

async function proxyHttpsResponse(proxyUrl, url, resolved, {
  signal,
  connectTimeoutMs,
} = {}) {
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw new Error(
      'receive_file supports only HTTP(S) proxies; unsupported proxy protocol: ' +
      proxy.protocol,
    );
  }
  const proxyClient = proxy.protocol === 'https:' ? https : http;
  const targetPort = Number(url.port || 443);
  const targetAuthority = net.isIP(resolved.address) === 6
    ? '[' + resolved.address + ']:' + targetPort
    : resolved.address + ':' + targetPort;
  const auth = proxyAuthorization(proxy);

  const tunnelSocket = await new Promise((resolve, reject) => {
    const request = proxyClient.request({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)),
      method: 'CONNECT',
      path: targetAuthority,
      headers: {
        Host: targetAuthority,
        ...(auth ? { 'Proxy-Authorization': auth } : {}),
      },
      signal,
    });
    request.setTimeout(connectTimeoutMs, () => {
      request.destroy(new Error('receive_file proxy connection timed out.'));
    });
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(
          'receive_file proxy CONNECT failed with HTTP ' + response.statusCode + '.',
        ));
        return;
      }
      resolve(socket);
    });
    request.on('error', reject);
    request.end();
  });

  const secureSocket = tls.connect({
    socket: tunnelSocket,
    servername: url.hostname,
  });
  const abort = () => secureSocket.destroy(
    new Error('receive_file download was aborted.'),
  );
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('receive_file TLS connection timed out.'));
        secureSocket.destroy();
      }, connectTimeoutMs);
      secureSocket.once('secureConnect', () => {
        clearTimeout(timer);
        resolve();
      });
      secureSocket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    return await requestResponse({
      protocol: 'https:',
      hostname: url.hostname,
      port: targetPort,
      servername: url.hostname,
      method: 'GET',
      path: url.pathname + url.search,
      headers: {
        Host: hostHeader(url),
        Accept: '*/*',
        'User-Agent': 'CCM receive_file',
      },
      agent: false,
      createConnection: () => secureSocket,
      signal,
    }, (request) => {
      request.setTimeout(connectTimeoutMs, () => {
        request.destroy(new Error('receive_file download connection timed out.'));
      });
    });
  } catch (error) {
    secureSocket.destroy();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

async function openHttpsResponse(url, {
  lookup = dns.lookup,
  proxyUrl = null,
  signal,
  connectTimeoutMs = DEFAULT_RECEIVE_FILE_CONNECT_TIMEOUT_MS,
} = {}) {
  if (url.protocol !== 'https:') {
    throw new Error('receive_file accepts HTTPS download URLs only.');
  }
  if (url.username || url.password) {
    throw new Error('receive_file download URL must not contain user credentials.');
  }
  const resolved = await resolvePublicTarget(url.hostname, lookup);
  return proxyUrl
    ? proxyHttpsResponse(proxyUrl, url, resolved, { signal, connectTimeoutMs })
    : directHttpsResponse(url, resolved, { signal, connectTimeoutMs });
}

async function nearestExistingAncestor(target) {
  let current = path.resolve(target);
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        'receive_file could not resolve an existing ancestor for destination.',
      );
    }
    current = parent;
  }
}

async function assertWorkspaceTarget(root, target) {
  const lexicalRoot = path.resolve(root);
  const absolute = path.resolve(target);
  if (!isWithin(lexicalRoot, absolute)) {
    throw new Error('receive_file destination escapes the selected workspace.');
  }
  const realRoot = await fs.realpath(lexicalRoot);
  const ancestor = await nearestExistingAncestor(path.dirname(absolute));
  const realAncestor = await fs.realpath(ancestor);
  if (!isWithin(realRoot, realAncestor)) {
    throw new Error(
      'receive_file refuses symlink/junction escape outside the selected workspace.',
    );
  }
}

async function prepareDestination(environment, destination, fileName) {
  const root = path.resolve(environment.cwd);
  let relative;
  if (destination != null && destination !== '') {
    if (path.isAbsolute(destination)) {
      throw new Error('receive_file destination must be relative to the selected workspace.');
    }
    relative = String(destination);
  } else {
    relative = sanitizeFileName(fileName);
  }
  const target = path.resolve(root, relative);
  await assertWorkspaceTarget(root, target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await assertWorkspaceTarget(root, target);

  const existing = await fs.lstat(target).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error('receive_file refuses to replace a symbolic-link destination.');
  }
  if (existing && !existing.isFile()) {
    throw new Error('receive_file destination exists and is not a file.');
  }
  return { target, existing };
}

async function openDownloadResponse(initialUrl, {
  lookup,
  proxyUrl,
  signal,
  connectTimeoutMs,
  maxRedirects,
  openResponse = openHttpsResponse,
} = {}) {
  let current;
  try {
    current = new URL(String(initialUrl));
  } catch {
    throw new Error('receive_file received an invalid download URL.');
  }
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await openResponse(current, {
      lookup,
      proxyUrl,
      signal,
      connectTimeoutMs,
    });
    if (!REDIRECT_CODES.has(Number(response.statusCode))) {
      return { response, url: current };
    }
    const location = response.headers?.location;
    response.resume?.();
    if (!location) {
      throw new Error(
        'receive_file redirect response omitted the Location header.',
      );
    }
    if (redirects === maxRedirects) {
      throw new Error('receive_file exceeded the redirect limit.');
    }
    try {
      current = new URL(location, current);
    } catch {
      throw new Error('receive_file received an invalid redirect URL.');
    }
    if (current.protocol !== 'https:') {
      throw new Error('receive_file refuses redirect to a non-HTTPS URL.');
    }
  }
  throw new Error('receive_file exceeded the redirect limit.');
}

async function publishTempFile(tempPath, target, overwrite) {
  if (overwrite) {
    await fs.rename(tempPath, target);
    return;
  }
  try {
    await fs.link(tempPath, target);
    await fs.unlink(tempPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(
        'receive_file destination already exists; set overwrite=true to replace it.',
      );
    }
    throw error;
  }
}

export async function receiveFileFromEnvironment({
  environment,
  file,
  destination = null,
  overwrite = false,
  maxBytes = DEFAULT_MAX_RECEIVE_FILE_BYTES,
  connectTimeoutMs = DEFAULT_RECEIVE_FILE_CONNECT_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_RECEIVE_FILE_TOTAL_TIMEOUT_MS,
  maxRedirects = DEFAULT_RECEIVE_FILE_MAX_REDIRECTS,
  lookup = dns.lookup,
  proxyUrl = undefined,
  openResponse = openHttpsResponse,
} = {}) {
  if (!environment) throw new Error('receive_file requires an environment.');
  if (!file?.download_url || !file?.file_id) {
    throw new Error('receive_file requires file.download_url and file.file_id.');
  }
  if ((environment.permissionProfile || 'workspace-write') === 'read-only') {
    throw new Error('receive_file cannot write in a read-only environment.');
  }
  const { target, existing } = await prepareDestination(
    environment,
    destination,
    file.file_name,
  );
  if (existing && !overwrite) {
    throw new Error(
      'receive_file destination already exists; set overwrite=true to replace it.',
    );
  }

  const effectiveProxy = proxyUrl === undefined
    ? discoverProxyUrl(process.env)
    : proxyUrl;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('receive_file exceeded the total download timeout.')),
    totalTimeoutMs,
  );
  timeout.unref?.();

  const tempPath = path.join(
    path.dirname(target),
    '.' + path.basename(target) + '.ccm-receive-' + crypto.randomUUID() + '.tmp',
  );
  let handle = null;
  let published = false;
  try {
    const { response, url: responseUrl } = await openDownloadResponse(file.download_url, {
      lookup,
      proxyUrl: effectiveProxy,
      signal: controller.signal,
      connectTimeoutMs,
      maxRedirects,
      openResponse,
    });
    const status = Number(response.statusCode || 0);
    if (status < 200 || status >= 300) {
      response.resume?.();
      throw new Error(
        'receive_file download failed with HTTP ' + status +
        ' for host ' + responseUrl.hostname + '.',
      );
    }
    const declaredLength = Number(response.headers?.['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.resume?.();
      throw new Error(
        'receive_file exceeds size limit (' + declaredLength + ' > ' +
        maxBytes + ' bytes).',
      );
    }

    handle = await fs.open(tempPath, 'wx');
    const hash = crypto.createHash('sha256');
    let byteLength = 0;
    for await (const chunkValue of response) {
      const chunk = Buffer.isBuffer(chunkValue)
        ? chunkValue
        : Buffer.from(chunkValue);
      byteLength += chunk.length;
      if (byteLength > maxBytes) {
        controller.abort();
        throw new Error(
          'receive_file exceeds size limit while downloading (' + byteLength +
          ' > ' + maxBytes + ' bytes).',
        );
      }
      hash.update(chunk);
      await handle.write(chunk);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await assertWorkspaceTarget(environment.cwd, target);
    await publishTempFile(tempPath, target, overwrite);
    published = true;

    return {
      path: target,
      filename: path.basename(target),
      mime_type: file.mime_type || 'application/octet-stream',
      byte_length: byteLength,
      sha256: hash.digest('hex'),
      file_id: String(file.file_id),
    };
  } catch (error) {
    if (controller.signal.aborted && error?.name === 'AbortError') {
      throw new Error('receive_file download timed out or was aborted.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => {});
    if (!published) await fs.unlink(tempPath).catch(() => {});
  }
}

export const receiveFileInternals = {
  sanitizeFileName,
  isPublicAddress,
  resolvePublicTarget,
  openHttpsResponse,
  prepareDestination,
};
