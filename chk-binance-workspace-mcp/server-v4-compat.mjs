import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_PORT = Number(process.env.V4_UPSTREAM_INTERNAL_PORT || (PORT + 10));
const BASE_PORT = Number(process.env.BASE_MCP_INTERNAL_PORT || (UPSTREAM_PORT + 1));
const MCP_LINK_TOKEN = process.env.MCP_LINK_TOKEN;
const SERVER_VERSION = '4.0.2';

if (!MCP_LINK_TOKEN) {
  console.error('Missing required environment variable: MCP_LINK_TOKEN');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = spawn(process.execPath, ['server-v4.mjs'], {
  cwd: here,
  env: {
    ...process.env,
    PORT: String(UPSTREAM_PORT),
    BASE_MCP_INTERNAL_PORT: String(BASE_PORT),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
upstream.on('exit', (code, signal) => console.error(`CHK Crypto MCP v4 upstream exited code=${code} signal=${signal}`));

function json(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
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

async function upstreamRequest(method, pathname, body = undefined, headers = {}) {
  const url = `http://127.0.0.1:${UPSTREAM_PORT}${pathname}`;
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const r = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? {'content-type':'application/json'} : {}),
          ...headers,
        },
        body,
      });
      const text = await r.text();
      return { status:r.status, ok:r.ok, text, headers:r.headers };
    } catch (error) {
      lastError = error;
      if (attempt < 9) await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('MCP v4 upstream indisponible');
}

async function upstreamRpc(message) {
  const path = `/mcp/${encodeURIComponent(MCP_LINK_TOKEN)}`;
  const r = await upstreamRequest('POST', path, JSON.stringify(message), {'mcp-protocol-version':'2025-06-18'});
  if (!r.ok) throw new Error(`MCP v4 upstream ${r.status}: ${r.text.slice(0,180)}`);
  return r.text ? JSON.parse(r.text) : null;
}

async function callUpstreamTool(name, args = {}, id = `compat-${Date.now()}-${Math.random()}`) {
  return upstreamRpc({
    jsonrpc:'2.0',
    id,
    method:'tools/call',
    params:{name,arguments:args},
  });
}

function resultStructured(r) {
  return r?.result?.structuredContent || null;
}

function resultError(r) {
  if (!r?.result?.isError) return null;
  const rows = Array.isArray(r.result.content) ? r.result.content : [];
  return rows.map(x => x?.text).filter(Boolean).join(' ') || 'Erreur inconnue';
}

async function withBybitPortfolio(baseResponse, message) {
  const bybitResponse = await callUpstreamTool('get_bybit_portfolio_summary', {}, `${message.id}-bybit-summary`);
  const bybit = resultStructured(bybitResponse);
  const bybitError = resultError(bybitResponse);
  const binance = resultStructured(baseResponse);
  if (!baseResponse?.result) return baseResponse;
  baseResponse.result.content = [{type:'text',text:bybitError ? 'Résumé Binance disponible ; lecture Bybit en erreur.' : 'Résumé Binance + portefeuille Bybit EU live.'}];
  baseResponse.result.structuredContent = {
    exchangeView:'BINANCE+BYBIT',
    binance,
    bybit,
    ...(bybitError ? {bybitError} : {}),
  };
  return baseResponse;
}

async function withBybitAssets(baseResponse, message) {
  const topN = Math.max(1, Math.min(50, Number(message.params?.arguments?.top_n || 20)));
  const bybitResponse = await callUpstreamTool('list_bybit_assets', {top_n:topN}, `${message.id}-bybit-assets`);
  const bybit = resultStructured(bybitResponse);
  const bybitError = resultError(bybitResponse);
  const binance = resultStructured(baseResponse);
  if (!baseResponse?.result) return baseResponse;
  baseResponse.result.content = [{type:'text',text:bybitError ? 'Actifs Binance disponibles ; lecture Bybit en erreur.' : 'Actifs Binance + Bybit EU live.'}];
  baseResponse.result.structuredContent = {
    exchangeView:'BINANCE+BYBIT',
    binance,
    bybit,
    ...(bybitError ? {bybitError} : {}),
  };
  return baseResponse;
}

async function withBybitAsset(baseResponse, message) {
  const symbol = String(message.params?.arguments?.symbol || '').trim().toUpperCase();
  const bybitResponse = await callUpstreamTool('list_bybit_assets', {top_n:50}, `${message.id}-bybit-asset`);
  const bybitData = resultStructured(bybitResponse);
  const bybitError = resultError(bybitResponse);
  const rows = Array.isArray(bybitData?.assets) ? bybitData.assets : [];
  const bybitAsset = rows.find(a => String(a?.coin || '').toUpperCase() === symbol) || null;
  const binance = resultStructured(baseResponse);
  if (!baseResponse?.result) return baseResponse;
  baseResponse.result.content = [{type:'text',text:bybitError ? `${symbol}: recherche Binance disponible ; lecture Bybit en erreur.` : `${symbol}: recherche effectuée sur Binance et Bybit EU.`}];
  baseResponse.result.structuredContent = {
    exchangeView:'BINANCE+BYBIT',
    symbol,
    binance,
    bybit:{found:!!bybitAsset,asset:bybitAsset},
    ...(bybitError ? {bybitError} : {}),
  };
  return baseResponse;
}

async function withBybitSnapshot(baseResponse, message) {
  const [summaryResponse, assetsResponse] = await Promise.all([
    callUpstreamTool('get_bybit_portfolio_summary', {}, `${message.id}-bybit-summary`),
    callUpstreamTool('list_bybit_assets', {top_n:50}, `${message.id}-bybit-assets`),
  ]);
  const summaryError = resultError(summaryResponse);
  const assetsError = resultError(assetsResponse);
  const bybitError = summaryError || assetsError || null;
  const binance = resultStructured(baseResponse);
  if (!baseResponse?.result) return baseResponse;
  baseResponse.result.content = [{type:'text',text:bybitError ? 'Instantané Binance disponible ; lecture Bybit partielle ou en erreur.' : 'Instantané Binance + état Bybit EU live.'}];
  baseResponse.result.structuredContent = {
    exchangeView:'BINANCE+BYBIT',
    binance,
    bybit:{
      summary:resultStructured(summaryResponse),
      assets:resultStructured(assetsResponse)?.assets || [],
    },
    ...(bybitError ? {bybitError} : {}),
  };
  return baseResponse;
}

async function rpcOne(message) {
  const response = await upstreamRpc(message);
  if (!response || !message) return response;

  if (message.method === 'initialize' && response?.result) {
    response.result.serverInfo = {name:'chk-crypto-workspace',version:SERVER_VERSION};
    response.result.capabilities = response.result.capabilities || {};
    response.result.capabilities.tools = {
      ...(response.result.capabilities.tools || {}),
      listChanged:true,
    };
    response.result.instructions = 'Persistent CHK Crypto Workspace. Tool discovery is dynamic. Binance is read/analysis/alerts. Bybit EU exposes live portfolio and Spot CRYPTO/USDC analysis; real Spot LIMIT orders and cancellations require explicit user confirmation. No Market orders, leverage, Futures, transfers or withdrawals.';
    return response;
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    try {
      if (name === 'get_portfolio_summary') return await withBybitPortfolio(response, message);
      if (name === 'list_assets') return await withBybitAssets(response, message);
      if (name === 'get_asset') return await withBybitAsset(response, message);
      if (name === 'get_latest_snapshot') return await withBybitSnapshot(response, message);
    } catch (error) {
      if (response?.result) {
        const current = resultStructured(response);
        response.result.structuredContent = {
          exchangeView:'BINANCE+BYBIT',
          binance:current,
          bybit:null,
          bybitError:String(error.message || error).slice(0,300),
        };
      }
    }
  }
  return response;
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') return json(res,405,{error:'method_not_allowed'},{allow:'POST'});
  let parsed;
  try { parsed = JSON.parse(await bodyText(req)); }
  catch { return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}); }

  const out = Array.isArray(parsed)
    ? (await Promise.all(parsed.map(rpcOne))).filter(Boolean)
    : await rpcOne(parsed);

  if ((Array.isArray(out) && !out.length) || out == null) {
    res.writeHead(202, {'cache-control':'no-store'});
    return res.end();
  }
  return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});
}

async function proxy(req, res, pathname) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bodyText(req);
  const r = await upstreamRequest(req.method, pathname, body);
  res.writeHead(r.status, {
    'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control':'no-store',
  });
  res.end(r.text);
}

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (validMcpPath(url.pathname)) return handleMcp(req,res);
    if (url.pathname === '/health') {
      const r = await upstreamRequest('GET','/health');
      let data = {};
      try { data = JSON.parse(r.text || '{}'); } catch {}
      return json(res,r.status,{...data,version:SERVER_VERSION,compatCachedTools:true,toolsListChanged:true});
    }
    if (url.pathname === '/') {
      const r = await upstreamRequest('GET','/');
      let data = {};
      try { data = JSON.parse(r.text || '{}'); } catch {}
      return json(res,r.status,{...data,version:SERVER_VERSION,compatCachedTools:true,toolsListChanged:true});
    }
    return proxy(req,res,url.pathname + url.search);
  } catch (error) {
    console.error('compat_request_error', error?.message || error);
    return json(res,500,{error:'server_error',message:String(error.message || error).slice(0,200)});
  }
});

server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto Workspace MCP compat v${SERVER_VERSION} listening on :${PORT}; upstream v4 on :${UPSTREAM_PORT}`));
