import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.V5_MCP_INTERNAL_PORT || (PORT + 1));
const MCP_LINK_TOKEN = process.env.MCP_LINK_TOKEN;
const SERVER_VERSION = '6.0.0';

if (!MCP_LINK_TOKEN) {
  console.error('Missing required environment variable: MCP_LINK_TOKEN');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ['server-v5.mjs'], {
  cwd: here,
  env: {
    ...process.env,
    PORT: String(INTERNAL_PORT),
    V4_MCP_INTERNAL_PORT: String(INTERNAL_PORT + 1),
    BASE_MCP_INTERNAL_PORT: String(INTERNAL_PORT + 2),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (code, signal) => console.error(`v5 MCP exited code=${code} signal=${signal}`));

function json(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    expires: '0',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...extra,
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

function constantEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function validMcpPath(pathname) {
  return pathname.startsWith('/mcp/') && constantEqual(pathname.slice(5), MCP_LINK_TOKEN);
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function v5Fetch(pathname, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}${pathname}`, options);
      return r;
    } catch (error) {
      lastError = error;
      if (attempt < 11) await wait(250);
    }
  }
  throw lastError || new Error('v5 MCP indisponible');
}

async function v5Rpc(message) {
  const r = await v5Fetch(`/mcp/${encodeURIComponent(MCP_LINK_TOKEN)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      accept: 'application/json',
    },
    body: JSON.stringify(message),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`v5 MCP ${r.status}: ${text.slice(0, 220)}`);
  return text ? JSON.parse(text) : null;
}

function upgradeInitialize(response) {
  if (!response?.result) return response;
  const existingCapabilities = response.result.capabilities || {};
  const existingTools = (existingCapabilities.tools && typeof existingCapabilities.tools === 'object')
    ? existingCapabilities.tools
    : {};
  response.result.serverInfo = { name: 'chk-crypto-workspace', version: SERVER_VERSION };
  response.result.capabilities = {
    ...existingCapabilities,
    tools: {
      ...existingTools,
      listChanged: true,
    },
  };
  response.result.instructions = 'CHK Crypto Workspace v6. Binance + Bybit EU. Bybit exposes live Spot portfolio/market tools, LIMIT and MARKET Spot orders on CRYPTO/USDC after explicit confirmation, plus cancellation. The server advertises tools.listChanged=true so clients must refresh tools/list when capabilities change. No leverage, Futures, transfers or withdrawals.';
  return response;
}

async function rpcOne(message) {
  const method = message?.method || 'unknown';
  const id = message?.id ?? null;
  if (method === 'initialize' || method === 'tools/list' || method === 'tools/call') {
    const toolName = method === 'tools/call' ? String(message?.params?.name || '') : '';
    console.log(`[MCP v6] ${method}${toolName ? ` ${toolName}` : ''}`);
  }

  if (method === 'initialize') {
    return upgradeInitialize(await v5Rpc(message));
  }

  if (method === 'tools/list') {
    const response = await v5Rpc(message);
    const tools = Array.isArray(response?.result?.tools) ? response.result.tools : [];
    const names = tools.map((t) => t?.name).filter(Boolean);
    const bybitNames = names.filter((name) => name.includes('bybit'));
    console.log(`[MCP v6] tools/list total=${names.length} bybit=${bybitNames.length} names=${bybitNames.join(',')}`);
    return response;
  }

  if (message && message.jsonrpc === '2.0') {
    return v5Rpc(message);
  }

  return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
  let parsed;
  try {
    parsed = JSON.parse(await bodyText(req));
  } catch {
    return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  const out = Array.isArray(parsed)
    ? (await Promise.all(parsed.map(rpcOne))).filter(Boolean)
    : await rpcOne(parsed);

  if ((Array.isArray(out) && !out.length) || out == null) {
    res.writeHead(202, { 'cache-control': 'no-store' });
    return res.end();
  }
  return json(res, 200, out, { 'mcp-protocol-version': '2025-06-18' });
}

async function proxy(req, res, pathname) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bodyText(req);
  const r = await v5Fetch(pathname, {
    method: req.method,
    headers: {
      ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
      accept: 'application/json',
    },
    body,
  });
  const text = await r.text();
  res.writeHead(r.status, {
    'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);

    if (validMcpPath(url.pathname)) return handleMcp(req, res);

    if (url.pathname === '/health') {
      const r = await v5Fetch('/health', { headers: { accept: 'application/json' } });
      const base = await r.json();
      return json(res, 200, {
        ...base,
        ok: true,
        name: 'chk-crypto-workspace',
        version: SERVER_VERSION,
        dynamicToolList: true,
        toolsListChanged: true,
      });
    }

    if (url.pathname === '/') {
      return json(res, 200, {
        name: 'CHK Crypto Workspace MCP',
        version: SERVER_VERSION,
        status: 'online',
        dynamicToolList: true,
        toolsListChanged: true,
        note: 'Binance + Bybit EU Spot. LIMIT + MARKET + cancel after explicit confirmation.',
      });
    }

    return proxy(req, res, url.pathname);
  } catch (error) {
    console.error('request_error', error?.message || error);
    return json(res, 500, { error: 'server_error', message: String(error.message || error).slice(0, 240) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CHK Crypto Workspace MCP v6 listening on :${PORT}; v5 base on :${INTERNAL_PORT}`);
});
