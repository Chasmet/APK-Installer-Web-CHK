import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_PORT = Number(process.env.V19_UPSTREAM_PORT || (PORT + 10));
const SERVER_VERSION = '19.0.0';
const BINANCE_BASE_URL = String(process.env.BINANCE_PUBLIC_BASE_URL || 'https://api.binance.com').replace(/\/$/, '');
const MCP_LINK_TOKEN = String(process.env.MCP_LINK_TOKEN || '');
const here = path.dirname(fileURLToPath(import.meta.url));

const child = spawn(process.execPath, ['server-v16.mjs'], {
  cwd: here,
  env: { ...process.env, PORT: String(UPSTREAM_PORT), V16_UPSTREAM_PORT: String(UPSTREAM_PORT + 10) },
  stdio: ['ignore', 'inherit', 'inherit']
});
child.on('exit', (code, signal) => console.error(`v16 exited code=${code} signal=${signal}`));

const readAnn = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const binanceTools = [
  {
    name: 'get_binance_market_snapshot',
    title: 'Snapshot marché Binance',
    description: 'Retourne les données publiques Binance Spot pour une paire : ticker 24h, bid/ask, carnet, gros murs et bougies 1m/5m/15m/1h/4h/1d/1w. Aucune clé privée requise.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Paire Binance, ex. RENDERUSDT ou BTCUSDC. Un symbole sans devise est complété par USDT.' },
        orderbook_limit: { type: 'integer', enum: [20, 50, 100, 500], default: 100 },
        candle_limit: { type: 'integer', minimum: 20, maximum: 200, default: 120 }
      }
    },
    annotations: readAnn
  },
  {
    name: 'get_binance_orderbook',
    title: 'Carnet Binance',
    description: 'Retourne le carnet public Binance Spot avec bid/ask, spread et plus gros murs classés par notionnel. Aucune clé privée requise.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Paire Binance, ex. RENDERUSDT.' },
        limit: { type: 'integer', enum: [5, 10, 20, 50, 100, 500, 1000, 5000], default: 100 }
      }
    },
    annotations: readAnn
  }
];
const binanceToolNames = new Set(binanceTools.map(t => t.name));

function constantEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function isMcpPath(p) {
  if (p === '/mcp') return true;
  return p.startsWith('/mcp/') && !!MCP_LINK_TOKEN && constantEqual(p.slice(5), MCP_LINK_TOKEN);
}
function json(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...extra
  });
  res.end(body);
}
async function bodyText(req, max = 2_000_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) throw new Error('request_too_large');
  }
  return body;
}
function normalizeSymbol(value) {
  const s = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{2,30}$/.test(s)) throw new Error('Symbole Binance invalide');
  const knownQuotes = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB', 'EUR'];
  return knownQuotes.some(q => s.endsWith(q)) ? s : `${s}USDT`;
}
const n = v => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
function bookRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const price = n(row?.[0]);
    const quantity = n(row?.[1]);
    return { price, quantity, notionalQuote: price != null && quantity != null ? price * quantity : null };
  });
}
function wallRows(rows, count = 10) {
  return [...rows]
    .filter(x => Number.isFinite(x.notionalQuote))
    .sort((a, b) => b.notionalQuote - a.notionalQuote)
    .slice(0, count);
}
function normalizeTicker(t) {
  return {
    symbol: t.symbol,
    lastPrice: n(t.lastPrice),
    priceChange: n(t.priceChange),
    priceChangePercent: n(t.priceChangePercent),
    weightedAvgPrice: n(t.weightedAvgPrice),
    openPrice: n(t.openPrice),
    highPrice: n(t.highPrice),
    lowPrice: n(t.lowPrice),
    volumeBase24h: n(t.volume),
    volumeQuote24h: n(t.quoteVolume),
    bidPrice: n(t.bidPrice),
    bidQty: n(t.bidQty),
    askPrice: n(t.askPrice),
    askQty: n(t.askQty),
    openTime: n(t.openTime),
    closeTime: n(t.closeTime),
    tradeCount: n(t.count)
  };
}
function normalizeKlines(rows) {
  return (Array.isArray(rows) ? rows : []).map(k => [
    n(k?.[0]), n(k?.[1]), n(k?.[2]), n(k?.[3]), n(k?.[4]), n(k?.[5]),
    n(k?.[6]), n(k?.[7]), n(k?.[8]), n(k?.[9]), n(k?.[10])
  ]);
}
async function binanceFetch(endpoint, params = {}) {
  const url = new URL(`${BINANCE_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const r = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': `chk-crypto-workspace/${SERVER_VERSION}` },
    signal: AbortSignal.timeout(8000)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text || '{}'); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}: ${data?.msg || data?.message || text.slice(0, 180)}`);
  return data;
}
async function getOrderbook(symbol, limit = 100) {
  const raw = await binanceFetch('/api/v3/depth', { symbol, limit });
  const bids = bookRows(raw.bids);
  const asks = bookRows(raw.asks);
  const bestBid = bids[0] || null;
  const bestAsk = asks[0] || null;
  return {
    symbol,
    source: 'Binance Spot public API',
    lastUpdateId: raw.lastUpdateId ?? null,
    bestBid,
    bestAsk,
    spread: bestBid?.price != null && bestAsk?.price != null ? bestAsk.price - bestBid.price : null,
    spreadPercent: bestBid?.price > 0 && bestAsk?.price != null ? ((bestAsk.price - bestBid.price) / bestBid.price) * 100 : null,
    largestBidWalls: wallRows(bids),
    largestAskWalls: wallRows(asks),
    bids,
    asks
  };
}
async function getMarketSnapshot(args = {}) {
  const symbol = normalizeSymbol(args.symbol);
  const orderbookLimit = [20, 50, 100, 500].includes(Number(args.orderbook_limit)) ? Number(args.orderbook_limit) : 100;
  const candleLimit = Math.max(20, Math.min(200, Number(args.candle_limit || 120)));
  const intervals = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
  const [tickerRaw, bookTickerRaw, orderbook, ...klinesRaw] = await Promise.all([
    binanceFetch('/api/v3/ticker/24hr', { symbol }),
    binanceFetch('/api/v3/ticker/bookTicker', { symbol }),
    getOrderbook(symbol, orderbookLimit),
    ...intervals.map(interval => binanceFetch('/api/v3/klines', { symbol, interval, limit: candleLimit }))
  ]);
  const candles = {};
  intervals.forEach((interval, i) => { candles[interval] = normalizeKlines(klinesRaw[i]); });
  return {
    symbol,
    source: 'Binance Spot public API',
    fetchedAt: new Date().toISOString(),
    ticker24h: normalizeTicker(tickerRaw),
    topOfBook: {
      bidPrice: n(bookTickerRaw.bidPrice), bidQty: n(bookTickerRaw.bidQty),
      askPrice: n(bookTickerRaw.askPrice), askQty: n(bookTickerRaw.askQty)
    },
    orderbook,
    candleFormat: ['openTime', 'open', 'high', 'low', 'close', 'volumeBase', 'closeTime', 'volumeQuote', 'trades', 'takerBuyBase', 'takerBuyQuote'],
    candles
  };
}
function rpcResult(id, data, text) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent: data } };
}
function rpcError(id, error) {
  const message = String(error?.message || error);
  return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }], structuredContent: { ok: false, error: message } } };
}
async function upstreamRpc(msg) {
  const r = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18', accept: 'application/json' },
    body: JSON.stringify(msg),
    signal: AbortSignal.timeout(30000)
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`v16 ${r.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text || '{}');
}
async function handleOne(msg) {
  if (msg?.method === 'initialize') {
    const out = await upstreamRpc(msg);
    if (out?.result) {
      out.result.serverInfo = { name: 'chk-crypto-workspace', version: SERVER_VERSION };
      out.result.capabilities = out.result.capabilities || {};
      out.result.capabilities.tools = { ...(out.result.capabilities.tools || {}), listChanged: true };
      out.result.instructions = `${out.result.instructions || ''} Binance Spot public market tools: get_binance_market_snapshot and get_binance_orderbook. These are read-only and require no Binance private key.`.trim();
    }
    return out;
  }
  if (msg?.method === 'tools/list') {
    const out = await upstreamRpc(msg);
    const tools = Array.isArray(out?.result?.tools) ? out.result.tools : [];
    for (const tool of binanceTools) if (!tools.some(t => t?.name === tool.name)) tools.push(tool);
    if (out?.result) out.result.tools = tools;
    console.log(`[MCP v19] tools/list count=${tools.length} binanceMarketTools=${binanceTools.map(t => t.name).join(',')}`);
    return out;
  }
  if (msg?.method !== 'tools/call') return upstreamRpc(msg);
  const name = String(msg?.params?.name || '');
  const args = msg?.params?.arguments || {};
  if (name === 'get_binance_orderbook') {
    try {
      const symbol = normalizeSymbol(args.symbol);
      const allowed = [5, 10, 20, 50, 100, 500, 1000, 5000];
      const limit = allowed.includes(Number(args.limit)) ? Number(args.limit) : 100;
      const data = await getOrderbook(symbol, limit);
      return rpcResult(msg.id, data, `Carnet Binance ${symbol} récupéré (${data.bids.length} bids / ${data.asks.length} asks).`);
    } catch (e) { return rpcError(msg.id, e); }
  }
  if (name === 'get_binance_market_snapshot') {
    try {
      const data = await getMarketSnapshot(args);
      return rpcResult(msg.id, data, `Snapshot Binance ${data.symbol} récupéré avec ticker, carnet et 7 timeframes.`);
    } catch (e) { return rpcError(msg.id, e); }
  }
  const out = await upstreamRpc(msg);
  if (name === 'get_workspace_info' && out?.result) {
    out.result.structuredContent = {
      ...(out.result.structuredContent || {}),
      catalogVersion: SERVER_VERSION,
      binanceMarketData: {
        available: true,
        publicApi: true,
        tools: ['get_binance_market_snapshot', 'get_binance_orderbook'],
        timeframes: ['1m', '5m', '15m', '1h', '4h', '1d', '1w']
      }
    };
    out.result.content = [...(out.result.content || []), { type: 'text', text: 'Binance Spot public market data enabled: ticker, order book and 1m/5m/15m/1h/4h/1d/1w candles.' }];
  }
  return out;
}
function proxy(req, res) {
  const upstreamReq = http.request({
    hostname: '127.0.0.1', port: UPSTREAM_PORT, path: req.url, method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${UPSTREAM_PORT}` }
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstreamReq.on('error', e => json(res, 502, { error: 'upstream_unavailable', message: String(e.message || e) }));
  req.pipe(upstreamReq);
}
async function waitForUpstream() {
  for (let i = 0; i < 160; i++) {
    try { const r = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('v16_startup_timeout');
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    if (u.pathname.startsWith('/mcp/') && !isMcpPath(u.pathname)) return json(res, 403, { error: 'mcp_forbidden' });
    if (isMcpPath(u.pathname) && req.method === 'POST') {
      const raw = await bodyText(req);
      let parsed;
      try { parsed = JSON.parse(raw || '{}'); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      if (!Array.isArray(parsed) && parsed.id === undefined && String(parsed.method || '').startsWith('notifications/')) {
        res.writeHead(202); return res.end();
      }
      const out = Array.isArray(parsed) ? await Promise.all(parsed.map(handleOne)) : await handleOne(parsed);
      return json(res, 200, out, { 'mcp-protocol-version': '2025-06-18' });
    }
    if (u.pathname === '/health') {
      let upstream = {};
      try { const r = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`); upstream = await r.json(); } catch {}
      return json(res, 200, { ...upstream, gatewayVersion: SERVER_VERSION, binanceMarketSnapshot: true, binanceOrderbook: true, binancePublicApi: true });
    }
    return proxy(req, res);
  } catch (e) {
    console.error('v19_request_error', e?.stack || e?.message || e);
    return json(res, 500, { error: 'server_error', message: String(e?.message || e).slice(0, 260) });
  }
});

try {
  await waitForUpstream();
  server.listen(PORT, '0.0.0.0', () => console.log(`CHK Crypto Gateway v${SERVER_VERSION} Binance public market data on :${PORT}`));
} catch (e) {
  console.error(e);
  child.kill('SIGTERM');
  process.exit(1);
}
