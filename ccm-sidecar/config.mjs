import fs from 'node:fs';
import path from 'node:path';

export const SIDECAR_HOST = '127.0.0.1';
export const SIDECAR_PORT = 18208;
export const UPSTREAM_URL = 'http://127.0.0.1:18209/ccm';
export const FORBIDDEN_PORTS = new Set([8317, 8765, 8766, 8767, 12306, 18209, 18301]);

function unquoteEnvValue(value) {
  if (value.length < 2) {
    return value;
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvFile(content) {
  const values = {};
  for (const rawLine of String(content).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) {
      continue;
    }
    values[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return values;
}

function resolveFromRoot(rootDir, value) {
  return path.isAbsolute(value) ? value : path.resolve(rootDir, value);
}

function requireInteger(name, value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum + '.');
  }
  return parsed;
}

function normalizeUpstreamUrl(value) {
  let upstream;
  try {
    upstream = new URL(value);
  } catch {
    throw new Error('CCM_UPSTREAM_URL must be a valid URL.');
  }
  if (
    upstream.protocol !== 'http:' ||
    upstream.hostname !== '127.0.0.1' ||
    upstream.port !== '18209' ||
    upstream.pathname.replace(/\/+$/u, '') !== '/ccm'
  ) {
    throw new Error('CCM_UPSTREAM_URL must remain http://127.0.0.1:18209/ccm.');
  }
  return UPSTREAM_URL;
}

function requireHttpsIdentity(name, value, expectedPath) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(name + ' is required.');
  let url;
  try { url = new URL(text); }
  catch { throw new Error(name + ' must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(name + ' must be a clean HTTPS URL without credentials, query, or fragment.');
  }
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
  if (pathname !== expectedPath) throw new Error(name + ' path must be ' + expectedPath + '.');
  return url.origin + expectedPath;
}

function wellKnownUrl(identity, kind) {
  const url = new URL(identity);
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/u, '');
  return `${url.origin}/.well-known/${kind}${pathname}`;
}

export function createConfig(options = {}) {
  const {
    rootDir = process.cwd(),
    envPath = path.join(rootDir, 'config', 'ccm.env'),
    envValues = {},
    readEnvFile = true,
    host,
    port,
    upstreamUrl,
    issuer,
    resource,
    stateFile,
    upstreamSessionFile,
    approvalSecretFile,
    logDir,
    tokenTtlSeconds,
    approvalSecret,
    allowEphemeral = false,
  } = options;

  let fileValues = {};
  if (readEnvFile) {
    if (!fs.existsSync(envPath)) {
      throw new Error('CCM config file was not found: ' + envPath);
    }
    fileValues = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
  }
  const values = { ...fileValues, ...envValues };
  const selectedHost = host ?? values.CCM_SIDECAR_HOST ?? SIDECAR_HOST;
  if (selectedHost !== SIDECAR_HOST) {
    throw new Error('CCM_SIDECAR_HOST must be ' + SIDECAR_HOST + '.');
  }

  const selectedPort = requireInteger(
    'CCM_SIDECAR_PORT',
    port ?? values.CCM_SIDECAR_PORT ?? SIDECAR_PORT,
    allowEphemeral ? 0 : 1,
    65535,
  );
  if (selectedPort !== 0 && FORBIDDEN_PORTS.has(selectedPort)) {
    throw new Error('CCM_SIDECAR_PORT cannot use a reserved port: ' + selectedPort + '.');
  }

  const selectedIssuer = requireHttpsIdentity(
    'CCM_ISSUER',
    issuer ?? values.CCM_ISSUER,
    '/ccm',
  );
  const selectedResource = requireHttpsIdentity(
    'CCM_RESOURCE',
    resource ?? values.CCM_RESOURCE,
    '/ccm/mcp',
  );
  if (new URL(selectedIssuer).origin !== new URL(selectedResource).origin) {
    throw new Error('CCM_ISSUER and CCM_RESOURCE must use the same HTTPS origin.');
  }
  const selectedUpstreamUrl = normalizeUpstreamUrl(
    upstreamUrl ?? values.CCM_UPSTREAM_URL ?? UPSTREAM_URL,
  );
  const selectedTtl = requireInteger(
    'CCM_TOKEN_TTL_SECONDS',
    tokenTtlSeconds ?? values.CCM_TOKEN_TTL_SECONDS ?? 3600,
    60,
    86400,
  );


  const selectedStateFile = resolveFromRoot(
    rootDir,
    stateFile ?? values.CCM_STATE_FILE ?? '.state/ccm-oauth-state.json',
  );
  const selectedUpstreamSessionFile = resolveFromRoot(
    rootDir,
    upstreamSessionFile ??
      values.CCM_UPSTREAM_SESSION_FILE ??
      '.state/ccm-upstream-session.json',
  );
  const selectedApprovalSecretFile = resolveFromRoot(
    rootDir,
    approvalSecretFile ??
      values.CCM_APPROVAL_SECRET_FILE ??
      '.state/ccm-approval-secret.txt',
  );
  const selectedLogDir = resolveFromRoot(rootDir, logDir ?? values.CCM_LOG_DIR ?? 'logs');

  return Object.freeze({
    rootDir,
    host: selectedHost,
    port: selectedPort,
    upstreamUrl: selectedUpstreamUrl,
    issuer: selectedIssuer,
    resource: selectedResource,
    protectedResourceMetadataUrl: wellKnownUrl(selectedResource, 'oauth-protected-resource'),
    authorizationServerMetadataUrl: wellKnownUrl(selectedIssuer, 'oauth-authorization-server'),
    stateFile: selectedStateFile,
    upstreamSessionFile: selectedUpstreamSessionFile,
    approvalSecretFile: selectedApprovalSecretFile,
    logDir: selectedLogDir,
    tokenTtlSeconds: selectedTtl,
    approvalSecret,
  });
}

export function loadConfig(rootDir = process.cwd()) {
  return createConfig({ rootDir });
}
