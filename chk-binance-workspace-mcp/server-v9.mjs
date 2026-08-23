import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_PORT = Number(process.env.V8_INTERNAL_PORT || (PORT + 10));
const SERVER_VERSION = '9.0.0';
const SIGNING_AUDIENCE = 'chk-crypto-signing';
const EXPECTED_REPOSITORY = 'Chasmet/Binance-bybyt-';
const EXPECTED_REF = 'refs/heads/main';
const EXPECTED_WORKFLOW = 'Chasmet/Binance-bybyt-/.github/workflows/build-apk.yml@refs/heads/main';

const KEYSTORE_B64 = String(process.env.CHK_ANDROID_KEYSTORE_BASE64 || '');
const STORE_PASSWORD = String(process.env.CHK_ANDROID_STORE_PASSWORD || '');
const KEY_ALIAS = String(process.env.CHK_ANDROID_KEY_ALIAS || '');
const KEY_PASSWORD = String(process.env.CHK_ANDROID_KEY_PASSWORD || '');
const signingConfigured = [KEYSTORE_B64, STORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD].every((v) => v.length > 0);

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ['server-v8.mjs'], {
  cwd: here,
  env: {
    ...process.env,
    PORT: String(UPSTREAM_PORT),
    V6_MCP_INTERNAL_PORT: String(UPSTREAM_PORT + 1),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (code, signal) => console.error(`v8 gateway exited code=${code} signal=${signal}`));

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    expires: '0',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function bodyText(req, max = 1_000_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) throw new Error('request_too_large');
  }
  return body;
}

function decodeBase64Url(value) {
  return Buffer.from(String(value).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

let jwksCache = { expiresAt: 0, keys: [] };
async function githubJwks() {
  if (jwksCache.expiresAt > Date.now() && jwksCache.keys.length) return jwksCache.keys;
  const response = await fetch('https://token.actions.githubusercontent.com/.well-known/jwks', {
    headers: { accept: 'application/json', 'user-agent': 'chk-crypto-signing-gateway' },
  });
  if (!response.ok) throw new Error(`github_jwks_${response.status}`);
  const root = await response.json();
  const keys = Array.isArray(root?.keys) ? root.keys : [];
  if (!keys.length) throw new Error('github_jwks_empty');
  jwksCache = { expiresAt: Date.now() + 60 * 60 * 1000, keys };
  return keys;
}

function audienceMatches(aud) {
  if (typeof aud === 'string') return aud === SIGNING_AUDIENCE;
  return Array.isArray(aud) && aud.includes(SIGNING_AUDIENCE);
}

async function verifyGithubOidc(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) throw new Error('invalid_jwt');
  let header, claims;
  try {
    header = JSON.parse(decodeBase64Url(parts[0]).toString('utf8'));
    claims = JSON.parse(decodeBase64Url(parts[1]).toString('utf8'));
  } catch {
    throw new Error('invalid_jwt_payload');
  }
  if (header?.alg !== 'RS256' || !header?.kid) throw new Error('invalid_jwt_header');
  const keys = await githubJwks();
  const jwk = keys.find((key) => key?.kid === header.kid && key?.kty === 'RSA');
  if (!jwk) throw new Error('unknown_github_oidc_key');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signature = decodeBase64Url(parts[2]);
  const valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, signature);
  if (!valid) throw new Error('invalid_github_oidc_signature');

  const now = Math.floor(Date.now() / 1000);
  if (claims?.iss !== 'https://token.actions.githubusercontent.com') throw new Error('invalid_issuer');
  if (!audienceMatches(claims?.aud)) throw new Error('invalid_audience');
  if (!Number.isFinite(Number(claims?.exp)) || Number(claims.exp) <= now) throw new Error('token_expired');
  if (claims?.nbf && Number(claims.nbf) > now + 30) throw new Error('token_not_yet_valid');
  if (claims?.repository !== EXPECTED_REPOSITORY) throw new Error('repository_not_allowed');
  if (claims?.ref !== EXPECTED_REF) throw new Error('ref_not_allowed');
  if (claims?.workflow_ref !== EXPECTED_WORKFLOW) throw new Error('workflow_not_allowed');
  if (!['push', 'workflow_dispatch'].includes(String(claims?.event_name || ''))) throw new Error('event_not_allowed');
  return claims;
}

async function handleSigning(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  if (!signingConfigured) return json(res, 503, { error: 'signing_not_configured' });
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return json(res, 401, { error: 'missing_oidc_token' });
  try {
    const claims = await verifyGithubOidc(auth.slice(7).trim());
    console.log(`Android signing material issued to GitHub Actions repo=${claims.repository} ref=${claims.ref} run_id=${claims.run_id || 'unknown'}`);
    return json(res, 200, {
      ok: true,
      keystoreBase64: KEYSTORE_B64,
      storePassword: STORE_PASSWORD,
      keyAlias: KEY_ALIAS,
      keyPassword: KEY_PASSWORD,
    });
  } catch (error) {
    console.warn(`Android signing OIDC rejected: ${error?.message || error}`);
    return json(res, 403, { error: 'oidc_forbidden' });
  }
}

async function proxy(req, res) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bodyText(req);
  const upstream = new URL(req.url, `http://127.0.0.1:${UPSTREAM_PORT}`);
  const response = await fetch(upstream, {
    method: req.method,
    headers: {
      ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
      ...(req.headers.accept ? { accept: req.headers.accept } : {}),
      ...(req.headers['mcp-protocol-version'] ? { 'mcp-protocol-version': req.headers['mcp-protocol-version'] } : {}),
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
    },
    body,
  });
  const text = await response.text();
  res.writeHead(response.status, {
    'content-type': response.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.pathname === '/ci/android-signing') return handleSigning(req, res);
    if (url.pathname === '/health') {
      const response = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);
      const upstream = await response.json();
      return json(res, 200, { ...upstream, gatewayVersion: SERVER_VERSION, stableSigningConfigured: signingConfigured });
    }
    return proxy(req, res);
  } catch (error) {
    console.error('v9_request_error', error?.message || error);
    return json(res, 500, { error: 'server_error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CHK Crypto Gateway v${SERVER_VERSION} listening on :${PORT}; v8 on :${UPSTREAM_PORT}; stableSigningConfigured=${signingConfigured}`);
});
