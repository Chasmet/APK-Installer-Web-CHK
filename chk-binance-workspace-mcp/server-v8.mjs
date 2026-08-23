import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL, URLSearchParams } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.V6_MCP_INTERNAL_PORT || (PORT + 1));
const MCP_LINK_TOKEN = String(process.env.MCP_LINK_TOKEN || '');
const EDGE_URL = String(process.env.SUPABASE_EDGE_URL || '');
const SUPABASE_MCP_TOKEN = String(process.env.SUPABASE_MCP_TOKEN || '');
const BINANCE_API_KEY = String(process.env.BINANCE_API_KEY || '').trim();
const BINANCE_API_SECRET = String(process.env.BINANCE_API_SECRET || '').trim();
const BYBIT_API_KEY = String(process.env.BYBIT_API_KEY || '').trim();
const BYBIT_API_SECRET = String(process.env.BYBIT_API_SECRET || '').trim();
const BYBIT_MAX_ORDER_USDC = Number(process.env.BYBIT_MAX_ORDER_USDC || 10);
const SERVER_VERSION = '8.0.0';
const BINANCE = 'https://api.binance.com';
const BYBIT = 'https://api.bybit.eu';
const RECV_WINDOW = '5000';

const BLOCKED_WRITE_TOOLS = new Set([
  'place_bybit_limit_order',
  'place_bybit_market_order',
  'cancel_bybit_order',
]);

for (const [name, value] of Object.entries({ MCP_LINK_TOKEN, EDGE_URL, SUPABASE_MCP_TOKEN })) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

function configured(value) {
  return !!value && !/^SET_ME/i.test(value) && !/^CHANGE_ME/i.test(value);
}

const binanceConfigured = configured(BINANCE_API_KEY) && configured(BINANCE_API_SECRET);
const bybitConfigured = configured(BYBIT_API_KEY) && configured(BYBIT_API_SECRET);

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ['server-v6.mjs'], {
  cwd: here,
  env: {
    ...process.env,
    PORT: String(INTERNAL_PORT),
    V5_MCP_INTERNAL_PORT: String(INTERNAL_PORT + 1),
    V4_MCP_INTERNAL_PORT: String(INTERNAL_PORT + 2),
    BASE_MCP_INTERNAL_PORT: String(INTERNAL_PORT + 3),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (code, signal) => console.error(`v6 MCP exited code=${code} signal=${signal}`));

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

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function edgeUrl(slug) {
  const u = new URL(EDGE_URL);
  u.pathname = u.pathname.replace(/\/chk-binance-workspace-latest\/?$/, `/${slug}`);
  return u.toString();
}

async function postEdge(slug, payload, serverAuth = false) {
  const r = await fetch(edgeUrl(slug), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'chk-crypto-workspace-v8',
      ...(serverAuth ? { 'x-chk-token': SUPABASE_MCP_TOKEN } : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text || 'null'); } catch { data = { raw: text }; }
  if (!r.ok) {
    const error = new Error(`${slug} ${r.status}: ${data?.error || data?.message || text.slice(0, 180)}`);
    error.httpStatus = r.status;
    throw error;
  }
  return data;
}

async function authorizeDevice(deviceId, deviceSecret, exchange) {
  const auth = await postEdge('chk-device-auth', { deviceId, deviceSecret, exchange }, false);
  const known = auth?.fingerprints && typeof auth.fingerprints === 'object' ? auth.fingerprints : {};
  const expectedBinance = binanceConfigured ? sha256(BINANCE_API_KEY) : null;
  const expectedBybit = bybitConfigured ? sha256(BYBIT_API_KEY) : null;
  const trusted =
    (expectedBinance && String(known.BINANCE || '') === expectedBinance) ||
    (expectedBybit && String(known.BYBIT || '') === expectedBybit);
  if (!trusted) {
    const error = new Error('Cette installation CHK Crypto n’est pas reconnue par les clés Render actuelles. Restaure ta sauvegarde CHK Crypto si l’application a été réinstallée.');
    error.httpStatus = 403;
    throw error;
  }
  return auth;
}

async function syncSnapshot(deviceId, deviceSecret, exchange, fingerprint, snapshot) {
  return postEdge('chk-crypto-sync', {
    deviceId,
    deviceSecret,
    exchange,
    accountFingerprint: fingerprint,
    appVersion: 'render-env-v8',
    snapshot,
  }, false);
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function v6Fetch(pathname, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${INTERNAL_PORT}${pathname}`, options);
    } catch (error) {
      lastError = error;
      if (attempt < 11) await wait(250);
    }
  }
  throw lastError || new Error('v6 MCP indisponible');
}

async function v6Rpc(message) {
  const r = await v6Fetch(`/mcp/${encodeURIComponent(MCP_LINK_TOKEN)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      accept: 'application/json',
    },
    body: JSON.stringify(message),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`v6 MCP ${r.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}

function decimalsFromStep(step) {
  const s = String(step || '');
  if (s.includes('e-')) return Math.min(12, Number(s.split('e-')[1]) || 0);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.slice(i + 1).replace(/0+$/, '').length;
}

function floorToStep(value, step) {
  const v = Number(value);
  const st = Number(step);
  if (!Number.isFinite(v) || v <= 0) throw new Error('Valeur numérique invalide.');
  if (!Number.isFinite(st) || st <= 0) return { number: v, formatted: String(v) };
  const decimals = decimalsFromStep(step);
  const floored = Math.floor((v + 1e-14) / st) * st;
  const formatted = floored.toFixed(decimals);
  const number = Number(formatted);
  if (!(number > 0)) throw new Error(`Valeur sous le pas minimum ${step}.`);
  return { number, formatted };
}

function cleanBybitSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30);
  if (!symbol || !symbol.endsWith('USDC') || symbol === 'USDCUSDC') throw new Error('Seules les paires Spot CRYPTO/USDC sont autorisées.');
  return symbol;
}

class ExchangeApiError extends Error {
  constructor(message, definitive = true) {
    super(message);
    this.definitive = definitive;
  }
}

async function binancePublic(pathname) {
  const r = await fetch(`${BINANCE}${pathname}`, { headers: { accept: 'application/json', 'user-agent': 'chk-crypto-workspace-v8' } });
  const text = await r.text();
  if (!r.ok) throw new ExchangeApiError(`Binance ${r.status}: ${text.slice(0, 180)}`);
  return JSON.parse(text || '{}');
}

async function binanceSigned(pathname, params = {}) {
  if (!binanceConfigured) throw new Error('Clés Binance Render absentes.');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
  qs.set('recvWindow', '5000');
  qs.set('timestamp', String(Date.now()));
  const signature = hmac(BINANCE_API_SECRET, qs.toString());
  qs.set('signature', signature);
  let r;
  try {
    r = await fetch(`${BINANCE}${pathname}?${qs}`, {
      headers: { accept: 'application/json', 'X-MBX-APIKEY': BINANCE_API_KEY, 'user-agent': 'chk-crypto-workspace-v8' },
    });
  } catch (error) {
    throw new ExchangeApiError(`Réseau Binance : ${error.message || error}`, false);
  }
  const text = await r.text();
  if (!r.ok) throw new ExchangeApiError(`Binance ${r.status}: ${text.slice(0, 220)}`);
  return JSON.parse(text || '{}');
}

function resolveBinancePrice(asset, prices, eurUsd) {
  if (['USDT', 'USDC', 'FDUSD', 'TUSD'].includes(asset)) return 1;
  if (asset === 'EUR') return eurUsd;
  for (const quote of ['USDT', 'USDC']) {
    const p = prices[`${asset}${quote}`];
    if (p > 0) return p;
  }
  const btc = prices[`${asset}BTC`];
  const btcUsd = prices.BTCUSDT || prices.BTCUSDC;
  if (btc > 0 && btcUsd > 0) return btc * btcUsd;
  return 0;
}

function binancePair(asset, prices) {
  for (const quote of ['USDT', 'USDC', 'EUR', 'BTC']) {
    if (prices[`${asset}${quote}`] > 0) return [asset + quote, quote];
  }
  return null;
}

function quoteToUsd(quote, prices, eurUsd) {
  if (['USDT', 'USDC', 'FDUSD', 'TUSD'].includes(quote)) return 1;
  if (quote === 'EUR') return eurUsd;
  if (quote === 'BTC') return prices.BTCUSDT || prices.BTCUSDC || 0;
  return prices[`${quote}USDT`] || prices[`${quote}USDC`] || 0;
}

async function loadBinanceWorkspace() {
  if (!binanceConfigured) throw new Error('Clés Binance non configurées dans Render.');
  const [tickerRows, account] = await Promise.all([
    binancePublic('/api/v3/ticker/price'),
    binanceSigned('/api/v3/account', { omitZeroBalances: 'true' }),
  ]);
  const prices = {};
  for (const row of Array.isArray(tickerRows) ? tickerRows : []) {
    const p = Number(row?.price || 0);
    if (row?.symbol && p > 0) prices[String(row.symbol).toUpperCase()] = p;
  }
  const eurUsd = prices.EURUSDT || prices.EURUSDC || 1.17;
  const holdings = [];
  let totalUsdt = 0;
  for (const b of Array.isArray(account?.balances) ? account.balances : []) {
    const asset = String(b?.asset || '').toUpperCase();
    const amount = Number(b?.free || 0) + Number(b?.locked || 0);
    if (!asset || !(amount > 0)) continue;
    const priceUsdt = resolveBinancePrice(asset, prices, eurUsd);
    const valueUsdt = amount * priceUsdt;
    totalUsdt += valueUsdt;
    holdings.push({ asset, amount, priceUsdt, valueUsdt });
  }
  holdings.sort((a, b) => b.valueUsdt - a.valueUsdt);

  const tradeRows = [];
  const historyBlocks = ['PRU ESTIMÉ PAR ACTIF'];
  let scanned = 0;
  for (const h of holdings) {
    if (scanned >= 15) break;
    if (['USDT', 'USDC', 'EUR', 'FDUSD', 'TUSD'].includes(h.asset) || !(h.priceUsdt > 0)) continue;
    const pair = binancePair(h.asset, prices);
    if (!pair) continue;
    scanned++;
    const [symbol, quote] = pair;
    const factor = quoteToUsd(quote, prices, eurUsd);
    let rows = [];
    try { rows = await binanceSigned('/api/v3/myTrades', { symbol, limit: 1000 }); } catch { continue; }
    const mapped = (Array.isArray(rows) ? rows : []).map((t) => {
      const qty = Number(t.qty || 0);
      const px = Number(t.price || 0);
      const quoteQty = Number(t.quoteQty || 0) || qty * px;
      return { symbol, asset: h.asset, side: t.isBuyer ? 'BUY' : 'SELL', qty, priceUsdt: px * factor, quoteUsdt: quoteQty * factor, time: Number(t.time || 0) };
    }).filter((t) => t.qty > 0 && t.priceUsdt > 0);
    tradeRows.push(...mapped);
    const buys = mapped.filter((t) => t.side === 'BUY');
    const sells = mapped.filter((t) => t.side === 'SELL');
    const buyQty = buys.reduce((s, t) => s + t.qty, 0);
    const buyCost = buys.reduce((s, t) => s + t.quoteUsdt, 0);
    const avg = buyQty > 0 ? buyCost / buyQty : 0;
    const pnl = avg > 0 ? (h.priceUsdt - avg) * h.amount : 0;
    const pnlPct = avg > 0 ? (h.priceUsdt / avg - 1) * 100 : 0;
    historyBlocks.push(`${h.asset}\nPRU ≈ ${avg > 0 ? avg.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : '—'} USD • actuel ${h.priceUsdt.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}\n${avg > 0 ? `Écart ≈ ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)} % • P/L ≈ ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD\n` : ''}${buys.length} achat(s) • ${sells.length} vente(s) Spot`);
  }
  historyBlocks.push('DERNIÈRES EXÉCUTIONS SPOT');
  for (const t of tradeRows.sort((a, b) => b.time - a.time).slice(0, 30)) {
    const d = new Date(t.time);
    historyBlocks.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} • ${t.asset} • ${t.side}\n${t.qty} à ${t.priceUsdt} USD ≈ ${t.quoteUsdt.toFixed(2)} USD`);
  }

  const capturedAt = Date.now();
  const portfolio = { capturedAt, totalUsdt, totalEur: eurUsd > 0 ? totalUsdt / eurUsd : totalUsdt, eurUsdt: eurUsd, holdings };
  const snapshot = {
    capturedAt,
    source: 'render_direct_binance',
    totalUsdt,
    totalEur: portfolio.totalEur,
    eurUsdt: eurUsd,
    assets: holdings.map((h) => ({ asset: h.asset, amount: h.amount, priceUsdt: h.priceUsdt, valueUsdt: h.valueUsdt, valueEur: eurUsd > 0 ? h.valueUsdt / eurUsd : h.valueUsdt })),
    spotTradeHistory: tradeRows.sort((a, b) => b.time - a.time).slice(0, 100),
  };
  return { portfolio, snapshot, historyText: historyBlocks.join('\n\n'), apiInfoText: 'Clé Binance gérée par Render • accès privé CHK Crypto' };
}

async function bybitPublic(pathname, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
  let r;
  try {
    r = await fetch(`${BYBIT}${pathname}${qs.size ? `?${qs}` : ''}`, { headers: { accept: 'application/json', 'user-agent': 'chk-crypto-workspace-v8' } });
  } catch (error) {
    throw new ExchangeApiError(`Réseau Bybit : ${error.message || error}`, false);
  }
  const text = await r.text();
  let root;
  try { root = JSON.parse(text); } catch { throw new ExchangeApiError(`Réponse Bybit invalide (${r.status})`); }
  if (!r.ok || Number(root.retCode || 0) !== 0) throw new ExchangeApiError(`Bybit ${root.retCode ?? r.status}: ${root.retMsg || text.slice(0, 180)}`);
  return root;
}

async function bybitSigned(method, pathname, paramsOrBody = {}) {
  if (!bybitConfigured) throw new Error('Clés Bybit Render absentes.');
  const timestamp = String(Date.now());
  let url = `${BYBIT}${pathname}`;
  let payload = '';
  let body;
  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(paramsOrBody)) if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
    payload = qs.toString();
    if (payload) url += `?${payload}`;
  } else {
    payload = JSON.stringify(paramsOrBody);
    body = payload;
  }
  const signature = hmac(BYBIT_API_SECRET, timestamp + BYBIT_API_KEY + RECV_WINDOW + payload);
  let r;
  try {
    r = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': 'chk-crypto-workspace-v8',
        'X-BAPI-API-KEY': BYBIT_API_KEY,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': RECV_WINDOW,
        'X-BAPI-SIGN': signature,
      },
      body,
    });
  } catch (error) {
    throw new ExchangeApiError(`Réseau Bybit : ${error.message || error}`, false);
  }
  const text = await r.text();
  let root;
  try { root = JSON.parse(text); } catch { throw new ExchangeApiError(`Réponse Bybit invalide (${r.status})`); }
  if (!r.ok || Number(root.retCode || 0) !== 0) throw new ExchangeApiError(`Bybit ${root.retCode ?? r.status}: ${root.retMsg || text.slice(0, 220)}`);
  return root;
}

async function bybitApiInfo() {
  const root = await bybitSigned('GET', '/v5/user/query-api', {});
  const info = root?.result || {};
  const spot = Array.isArray(info?.permissions?.Spot) ? info.permissions.Spot : [];
  return { readOnly: Number(info.readOnly) === 1, spotPermissions: spot, canSpotTrade: Number(info.readOnly) === 0 && spot.includes('SpotTrade') };
}

async function loadBybitExecutions(maxPages = 5) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const params = { category: 'spot', limit: 100, ...(cursor ? { cursor } : {}) };
    const root = await bybitSigned('GET', '/v5/execution/list', params);
    const list = Array.isArray(root?.result?.list) ? root.result.list : [];
    out.push(...list);
    const next = String(root?.result?.nextPageCursor || '');
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

function bybitTickerMap(rows) {
  const map = {};
  for (const row of rows) {
    const p = Number(row?.lastPrice || 0);
    if (row?.symbol && p > 0) map[String(row.symbol).toUpperCase()] = p;
  }
  return map;
}

function resolveBybitUsdPrice(asset, prices, eurUsd) {
  if (['USDT', 'USDC', 'FDUSD', 'TUSD'].includes(asset)) return 1;
  if (asset === 'EUR') return eurUsd;
  if (prices[`${asset}USDC`] > 0) return prices[`${asset}USDC`];
  if (prices[`${asset}USDT`] > 0) return prices[`${asset}USDT`];
  const btc = prices[`${asset}BTC`];
  const btcUsd = prices.BTCUSDT || prices.BTCUSDC;
  return btc > 0 && btcUsd > 0 ? btc * btcUsd : 0;
}

async function loadBybitWorkspace() {
  if (!bybitConfigured) throw new Error('Clés Bybit non configurées dans Render.');
  const [apiInfo, tickersRoot, walletRoot, executions] = await Promise.all([
    bybitApiInfo(),
    bybitPublic('/v5/market/tickers', { category: 'spot' }),
    bybitSigned('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' }),
    loadBybitExecutions(5),
  ]);
  const tickerRows = Array.isArray(tickersRoot?.result?.list) ? tickersRoot.result.list : [];
  const prices = bybitTickerMap(tickerRows);
  const eurUsd = prices.EURUSDC || prices.EURUSDT || 1.17;
  const account = walletRoot?.result?.list?.[0] || {};
  const coins = Array.isArray(account?.coin) ? account.coin : [];
  const holdings = [];
  let sumUsd = 0;
  for (const c of coins) {
    const asset = String(c?.coin || '').toUpperCase();
    const amount = Number(c?.walletBalance || 0);
    if (!asset || !(amount > 0)) continue;
    let valueUsdt = Number(c?.usdValue || 0);
    let priceUsdt = amount > 0 && valueUsdt > 0 ? valueUsdt / amount : resolveBybitUsdPrice(asset, prices, eurUsd);
    if (!(valueUsdt > 0) && priceUsdt > 0) valueUsdt = amount * priceUsdt;
    if (!(priceUsdt > 0) && valueUsdt > 0) priceUsdt = valueUsdt / amount;
    sumUsd += valueUsdt;
    holdings.push({ asset, amount, priceUsdt, valueUsdt });
  }
  holdings.sort((a, b) => b.valueUsdt - a.valueUsdt);
  const totalUsdt = Number(account?.totalEquity || 0) || sumUsd;

  const mapped = executions.map((x) => {
    const symbol = String(x?.symbol || '').toUpperCase();
    const quote = ['USDC', 'USDT', 'EUR', 'BTC'].find((q) => symbol.endsWith(q)) || '';
    const asset = quote ? symbol.slice(0, -quote.length) : symbol;
    const qty = Number(x?.execQty || 0);
    const rawPrice = Number(x?.execPrice || 0);
    let factor = 1;
    if (quote === 'EUR') factor = eurUsd;
    else if (quote === 'BTC') factor = prices.BTCUSDT || prices.BTCUSDC || 0;
    const priceUsdt = rawPrice * factor;
    const quoteValue = Number(x?.execValue || 0) || qty * rawPrice;
    return { symbol, asset, side: String(x?.side || '').toUpperCase(), qty, priceUsdt, quoteUsdt: quoteValue * factor, time: Number(x?.execTime || 0) };
  }).filter((x) => x.qty > 0 && x.priceUsdt > 0 && ['BUY', 'SELL'].includes(x.side));

  const historyBlocks = ['PRU ESTIMÉ BYBIT SPOT'];
  const held = new Map(holdings.map((h) => [h.asset, h]));
  const groups = new Map();
  for (const row of mapped) {
    if (!groups.has(row.asset)) groups.set(row.asset, []);
    groups.get(row.asset).push(row);
  }
  for (const [asset, rows] of groups.entries()) {
    const h = held.get(asset);
    if (!h) continue;
    const buys = rows.filter((r) => r.side === 'BUY');
    const sells = rows.filter((r) => r.side === 'SELL');
    const buyQty = buys.reduce((s, r) => s + r.qty, 0);
    const buyCost = buys.reduce((s, r) => s + r.quoteUsdt, 0);
    const avg = buyQty > 0 ? buyCost / buyQty : 0;
    const pnl = avg > 0 ? (h.priceUsdt - avg) * h.amount : 0;
    const pnlPct = avg > 0 ? (h.priceUsdt / avg - 1) * 100 : 0;
    historyBlocks.push(`${asset}\nPRU ≈ ${avg > 0 ? avg.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : '—'} USD • actuel ${h.priceUsdt.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}\n${avg > 0 ? `Écart ≈ ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)} % • P/L ≈ ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USD\n` : ''}${buys.length} achat(s) • ${sells.length} vente(s) Spot`);
  }
  historyBlocks.push('DERNIÈRES EXÉCUTIONS SPOT');
  for (const t of mapped.sort((a, b) => b.time - a.time).slice(0, 30)) {
    const d = new Date(t.time);
    historyBlocks.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} • ${t.asset} • ${t.side}\n${t.qty} à ${t.priceUsdt} USD ≈ ${t.quoteUsdt.toFixed(2)} USD`);
  }

  const capturedAt = Date.now();
  const portfolio = { capturedAt, totalUsdt, totalEur: eurUsd > 0 ? totalUsdt / eurUsd : totalUsdt, eurUsdt: eurUsd, holdings };
  const snapshot = {
    capturedAt,
    source: 'render_direct_bybit_eu',
    totalUsdt,
    totalEur: portfolio.totalEur,
    eurUsdt: eurUsd,
    assets: holdings.map((h) => ({ asset: h.asset, amount: h.amount, priceUsdt: h.priceUsdt, valueUsdt: h.valueUsdt, valueEur: eurUsd > 0 ? h.valueUsdt / eurUsd : h.valueUsdt })),
    spotTradeHistory: mapped.sort((a, b) => b.time - a.time).slice(0, 100),
  };
  const apiInfoText = `Clé Bybit gérée par Render • ${apiInfo.readOnly ? 'lecture seule' : 'lecture-écriture'} • Spot : ${apiInfo.spotPermissions.join(', ') || 'non indiqué'}`;
  return { portfolio, snapshot, historyText: historyBlocks.join('\n\n'), apiInfoText, apiInfo };
}

async function bybitInstrument(symbol) {
  const root = await bybitPublic('/v5/market/instruments-info', { category: 'spot', symbol });
  const item = root?.result?.list?.[0];
  if (!item) throw new Error(`Paire ${symbol} introuvable sur Bybit EU Spot.`);
  if (String(item.status || '').toLowerCase() !== 'trading') throw new Error(`${symbol} n’est pas actuellement tradable.`);
  return item;
}

async function bybitWalletCoins() {
  const root = await bybitSigned('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  const account = root?.result?.list?.[0] || {};
  return Array.isArray(account?.coin) ? account.coin : [];
}

function usableCoinBalance(coin) {
  return Math.max(0, Number(coin?.walletBalance || 0) - Number(coin?.locked || 0) - Number(coin?.spotBorrow || 0));
}

async function currentBybitPrice(symbol) {
  const root = await bybitPublic('/v5/market/tickers', { category: 'spot', symbol });
  const t = root?.result?.list?.[0] || {};
  const bid = Number(t.bid1Price || 0), ask = Number(t.ask1Price || 0), last = Number(t.lastPrice || 0);
  return last || (bid > 0 && ask > 0 ? (bid + ask) / 2 : bid || ask);
}

function proposalOrderLinkId(id) {
  return `chk${sha256(id).slice(0, 32)}`;
}

function orderResultFromRow(row, proposal, orderLinkId) {
  const executedQty = Number(row?.cumExecQty || row?.execQty || 0);
  const executedValueUsdc = Number(row?.cumExecValue || row?.execValue || 0);
  const averagePrice = Number(row?.avgPrice || 0) || (executedQty > 0 && executedValueUsdc > 0 ? executedValueUsdc / executedQty : 0);
  return {
    orderId: String(row?.orderId || ''),
    orderLinkId: String(row?.orderLinkId || orderLinkId),
    orderStatus: String(row?.orderStatus || 'SENT'),
    executedQty,
    executedValueUsdc,
    averagePrice,
    symbol: proposal.symbol,
    side: proposal.side,
    orderType: proposal.order_type,
    requestedQty: Number(proposal.base_quantity || 0),
    requestedValueUsdc: Number(proposal.quote_amount_usdc || 0),
    limitPrice: Number(proposal.limit_price || 0),
  };
}

async function findBybitOrder(symbol, orderLinkId) {
  for (const endpoint of ['/v5/order/realtime', '/v5/order/history']) {
    try {
      const root = await bybitSigned('GET', endpoint, { category: 'spot', symbol, orderLinkId, limit: 20 });
      const rows = Array.isArray(root?.result?.list) ? root.result.list : [];
      const found = rows.find((row) => String(row?.orderLinkId || '') === orderLinkId);
      if (found) return found;
    } catch {}
  }
  return null;
}

async function serverProposal(id) {
  const data = await postEdge('chk-trade-proposals', { action: 'server_get_proposal', id }, true);
  return data?.proposal || null;
}

async function serverMarkResult(proposal, status, result, orderId = '') {
  return postEdge('chk-trade-proposals', {
    action: 'server_mark_result',
    id: proposal.id,
    status,
    processingOwner: proposal.processing_owner,
    accountFingerprint: proposal.account_fingerprint,
    bybitOrderId: orderId,
    result,
  }, true);
}

function validateProcessingProposal(proposal, deviceId) {
  if (!proposal) throw new Error('Proposition introuvable.');
  if (String(proposal.status) !== 'processing') throw new Error(`Proposition non exécutable : statut ${proposal.status}.`);
  if (String(proposal.processing_owner || '') !== String(deviceId)) throw new Error('Cette proposition est verrouillée par une autre installation.');
  if (String(proposal.exchange || '').toUpperCase() !== 'BYBIT') throw new Error('Exchange invalide.');
  const expectedFingerprint = sha256(BYBIT_API_KEY);
  if (!constantEqual(String(proposal.account_fingerprint || ''), expectedFingerprint)) throw new Error('La proposition ne correspond pas à la clé Bybit active sur Render.');
  const expires = Date.parse(String(proposal.expires_at || ''));
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('La proposition a expiré.');
  const symbol = cleanBybitSymbol(proposal.symbol);
  const side = String(proposal.side || '').toUpperCase();
  const orderType = String(proposal.order_type || '').toUpperCase();
  const quote = Number(proposal.quote_amount_usdc || 0);
  if (!['BUY', 'SELL'].includes(side) || !['LIMIT', 'MARKET'].includes(orderType)) throw new Error('Type de proposition invalide.');
  if (!(quote > 1) || quote > BYBIT_MAX_ORDER_USDC + 1e-9) throw new Error(`Montant hors limites CHK Crypto (>1 et ≤${BYBIT_MAX_ORDER_USDC} USDC).`);
  return { symbol, side, orderType, quote };
}

async function buildBybitOrder(proposal, orderLinkId) {
  const { symbol, side, orderType, quote } = validateProcessingProposal(proposal, proposal.processing_owner);
  const apiInfo = await bybitApiInfo();
  if (!apiInfo.canSpotTrade) throw new Error('La clé Bybit Render n’a pas la permission SpotTrade.');
  const info = await bybitInstrument(symbol);
  const coins = await bybitWalletCoins();
  const baseCoin = symbol.slice(0, -4);
  const minOrderAmt = Number(info?.lotSizeFilter?.minOrderAmt || 0);
  const qtyStep = String(info?.lotSizeFilter?.qtyStep || '0');
  const tickSize = String(info?.priceFilter?.tickSize || '0');

  if (orderType === 'LIMIT') {
    const rawPrice = Number(proposal.limit_price || 0);
    if (!(rawPrice > 0)) throw new Error('Prix LIMIT manquant.');
    const price = floorToStep(rawPrice, tickSize);
    const rawQty = Number(proposal.base_quantity || 0) > 0 ? Number(proposal.base_quantity) : quote / price.number;
    const qty = floorToStep(rawQty, qtyStep);
    const notional = qty.number * price.number;
    if (!(notional > 1) || notional > BYBIT_MAX_ORDER_USDC + 1e-9) throw new Error(`Valeur LIMIT ${notional.toFixed(4)} USDC hors limites (>1 et ≤${BYBIT_MAX_ORDER_USDC}).`);
    if (minOrderAmt > 0 && notional + 1e-12 < minOrderAmt) throw new Error(`Minimum Bybit actuel : ${minOrderAmt} USDC.`);
    if (side === 'BUY') {
      const available = usableCoinBalance(coins.find((c) => c.coin === 'USDC'));
      if (available + 1e-9 < notional) throw new Error(`Solde USDC insuffisant (${available.toFixed(4)} USDC).`);
    } else {
      const available = usableCoinBalance(coins.find((c) => c.coin === baseCoin));
      if (available + 1e-12 < qty.number) throw new Error(`Solde ${baseCoin} insuffisant (${available}).`);
    }
    return {
      category: 'spot', symbol, side: side === 'BUY' ? 'Buy' : 'Sell', orderType: 'Limit',
      qty: qty.formatted, price: price.formatted, timeInForce: 'GTC', isLeverage: 0,
      orderFilter: 'Order', orderLinkId,
    };
  }

  if (side === 'BUY') {
    const amount = floorToStep(quote, '0.000001');
    if (!(amount.number > 1) || amount.number > BYBIT_MAX_ORDER_USDC + 1e-9) throw new Error('Montant MARKET BUY hors limites.');
    if (minOrderAmt > 0 && amount.number + 1e-12 < minOrderAmt) throw new Error(`Minimum Bybit actuel : ${minOrderAmt} USDC.`);
    const available = usableCoinBalance(coins.find((c) => c.coin === 'USDC'));
    if (available + 1e-9 < amount.number) throw new Error(`Solde USDC insuffisant (${available.toFixed(4)} USDC).`);
    return {
      category: 'spot', symbol, side: 'Buy', orderType: 'Market', qty: amount.formatted,
      marketUnit: 'quoteCoin', timeInForce: 'IOC', isLeverage: 0, orderFilter: 'Order', orderLinkId,
    };
  }

  const rawQty = Number(proposal.base_quantity || 0);
  if (!(rawQty > 0)) throw new Error('Quantité MARKET SELL manquante.');
  const qty = floorToStep(rawQty, qtyStep);
  const available = usableCoinBalance(coins.find((c) => c.coin === baseCoin));
  if (available + 1e-12 < qty.number) throw new Error(`Solde ${baseCoin} insuffisant (${available}).`);
  const px = await currentBybitPrice(symbol);
  if (!(px > 0)) throw new Error(`Prix ${symbol} indisponible.`);
  const estimated = qty.number * px;
  if (!(estimated > 1) || estimated > BYBIT_MAX_ORDER_USDC + 1e-9) throw new Error(`Valeur MARKET SELL estimée ${estimated.toFixed(4)} USDC hors limites.`);
  if (minOrderAmt > 0 && estimated + 1e-12 < minOrderAmt) throw new Error(`Minimum Bybit actuel : ${minOrderAmt} USDC.`);
  return {
    category: 'spot', symbol, side: 'Sell', orderType: 'Market', qty: qty.formatted,
    marketUnit: 'baseCoin', timeInForce: 'IOC', isLeverage: 0, orderFilter: 'Order', orderLinkId,
  };
}

async function executeProposal(deviceId, proposalId) {
  const proposal = await serverProposal(proposalId);
  const { symbol } = validateProcessingProposal(proposal, deviceId);
  const orderLinkId = proposalOrderLinkId(proposal.id);

  const existing = await findBybitOrder(symbol, orderLinkId);
  if (existing) {
    const result = orderResultFromRow(existing, proposal, orderLinkId);
    await serverMarkResult(proposal, 'executed', result, result.orderId);
    return result;
  }

  const body = await buildBybitOrder(proposal, orderLinkId);
  let createRoot;
  try {
    createRoot = await bybitSigned('POST', '/v5/order/create', body);
  } catch (error) {
    const recovered = await findBybitOrder(symbol, orderLinkId);
    if (recovered) {
      const result = orderResultFromRow(recovered, proposal, orderLinkId);
      await serverMarkResult(proposal, 'executed', result, result.orderId);
      return result;
    }
    if (error?.definitive !== false) {
      const result = { error: String(error.message || error), orderLinkId, orderStatus: 'REJECTED' };
      await serverMarkResult(proposal, 'error', result, '');
    }
    throw error;
  }

  let row = null;
  for (const delay of [250, 700, 1500, 3000]) {
    await wait(delay);
    row = await findBybitOrder(symbol, orderLinkId);
    if (row) break;
  }
  if (!row) {
    row = {
      orderId: createRoot?.result?.orderId || '',
      orderLinkId: createRoot?.result?.orderLinkId || orderLinkId,
      orderStatus: 'SENT',
      cumExecQty: '0',
      cumExecValue: '0',
      avgPrice: '0',
    };
  }
  const result = orderResultFromRow(row, proposal, orderLinkId);
  await serverMarkResult(proposal, 'executed', result, result.orderId);
  return result;
}

async function reconcileProposal(deviceId, proposalId) {
  const proposal = await serverProposal(proposalId);
  if (!proposal) throw new Error('Proposition introuvable.');
  if (String(proposal.processing_owner || '') && String(proposal.processing_owner) !== String(deviceId)) throw new Error('Proposition liée à une autre installation.');
  if (!constantEqual(String(proposal.account_fingerprint || ''), sha256(BYBIT_API_KEY))) throw new Error('Proposition liée à une autre clé Bybit.');
  const symbol = cleanBybitSymbol(proposal.symbol);
  const orderLinkId = proposalOrderLinkId(proposal.id);
  const row = await findBybitOrder(symbol, orderLinkId);
  if (!row) return null;
  const result = orderResultFromRow(row, proposal, orderLinkId);
  if (String(proposal.status) === 'processing') await serverMarkResult(proposal, 'executed', result, result.orderId);
  return result;
}

async function handleApkSync(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const body = JSON.parse(await bodyText(req, 100_000));
  const deviceId = String(body?.deviceId || '').trim();
  const deviceSecret = String(body?.deviceSecret || '');
  const exchange = String(body?.exchange || '').trim().toUpperCase();
  if (!['BINANCE', 'BYBIT'].includes(exchange)) return json(res, 400, { error: 'invalid_exchange' });
  await authorizeDevice(deviceId, deviceSecret, exchange);
  const data = exchange === 'BINANCE' ? await loadBinanceWorkspace() : await loadBybitWorkspace();
  const fingerprint = sha256(exchange === 'BINANCE' ? BINANCE_API_KEY : BYBIT_API_KEY);
  const sync = await syncSnapshot(deviceId, deviceSecret, exchange, fingerprint, data.snapshot);
  return json(res, 200, {
    ok: true,
    exchange,
    portfolio: data.portfolio,
    historyText: data.historyText,
    apiInfoText: data.apiInfoText,
    syncedAt: sync?.syncedAt || new Date().toISOString(),
  });
}

async function handleApkStatus(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const body = JSON.parse(await bodyText(req, 50_000));
  const deviceId = String(body?.deviceId || '').trim();
  const deviceSecret = String(body?.deviceSecret || '');
  await authorizeDevice(deviceId, deviceSecret, String(body?.exchange || 'BYBIT').toUpperCase());
  let bybit = { configured: bybitConfigured, canSpotTrade: false };
  if (bybitConfigured) {
    try { bybit = { configured: true, ...(await bybitApiInfo()) }; } catch (error) { bybit = { configured: true, canSpotTrade: false, error: String(error.message || error) }; }
  }
  return json(res, 200, { ok: true, binance: { configured: binanceConfigured }, bybit });
}

async function handleApkExecute(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const body = JSON.parse(await bodyText(req, 50_000));
  const deviceId = String(body?.deviceId || '').trim();
  const deviceSecret = String(body?.deviceSecret || '');
  const proposalId = String(body?.proposalId || '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(proposalId)) return json(res, 400, { error: 'invalid_proposal_id' });
  await authorizeDevice(deviceId, deviceSecret, 'BYBIT');
  try {
    const result = await executeProposal(deviceId, proposalId);
    return json(res, 200, { ok: true, result });
  } catch (error) {
    const status = Number(error?.httpStatus || 0) || (error?.definitive === false ? 503 : 400);
    return json(res, status, { error: error?.definitive === false ? 'bybit_state_uncertain' : 'bybit_order_failed', message: String(error.message || error).slice(0, 400) });
  }
}

async function handleApkReconcile(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });
  const body = JSON.parse(await bodyText(req, 50_000));
  const deviceId = String(body?.deviceId || '').trim();
  const deviceSecret = String(body?.deviceSecret || '');
  const proposalId = String(body?.proposalId || '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(proposalId)) return json(res, 400, { error: 'invalid_proposal_id' });
  await authorizeDevice(deviceId, deviceSecret, 'BYBIT');
  const result = await reconcileProposal(deviceId, proposalId);
  return json(res, 200, { ok: true, found: !!result, result });
}

async function directBybitTool(name, args = {}) {
  if (name === 'get_bybit_connection_info') {
    if (!bybitConfigured) return { connected: false, canSpotTrade: false, source: 'render_env' };
    const info = await bybitApiInfo();
    return { connected: true, source: 'render_env', ...info };
  }
  if (name === 'get_bybit_portfolio_summary' || name === 'list_bybit_assets') {
    const data = await loadBybitWorkspace();
    if (name === 'list_bybit_assets') {
      const n = Math.max(1, Math.min(50, Number(args.top_n || 20)));
      return { assets: data.portfolio.holdings.slice(0, n).map((h) => ({ coin: h.asset, walletBalance: h.amount, usdValue: h.valueUsdt, priceUsdt: h.priceUsdt })) };
    }
    return { totalEquity: data.portfolio.totalUsdt, totalEur: data.portfolio.totalEur, assetCount: data.portfolio.holdings.length, topAssets: data.portfolio.holdings.slice(0, 8) };
  }
  if (name === 'list_bybit_open_orders') {
    const params = { category: 'spot', limit: Math.max(1, Math.min(50, Number(args.limit || 20))) };
    if (args.symbol) params.symbol = cleanBybitSymbol(args.symbol);
    const root = await bybitSigned('GET', '/v5/order/realtime', params);
    return { orders: Array.isArray(root?.result?.list) ? root.result.list : [] };
  }
  if (name === 'list_bybit_recent_executions') {
    const params = { category: 'spot', limit: Math.max(1, Math.min(100, Number(args.limit || 30))) };
    if (args.symbol) params.symbol = cleanBybitSymbol(args.symbol);
    const root = await bybitSigned('GET', '/v5/execution/list', params);
    return { executions: Array.isArray(root?.result?.list) ? root.result.list : [] };
  }
  if (name === 'list_bybit_usdc_markets') {
    const root = await bybitPublic('/v5/market/tickers', { category: 'spot' });
    const n = Math.max(1, Math.min(100, Number(args.limit || 30)));
    const markets = (Array.isArray(root?.result?.list) ? root.result.list : [])
      .filter((x) => String(x.symbol || '').endsWith('USDC') && !String(x.symbol || '').startsWith('USDC'))
      .map((x) => ({ symbol: x.symbol, lastPrice: Number(x.lastPrice || 0), turnover24h: Number(x.turnover24h || 0), volume24h: Number(x.volume24h || 0), bid1Price: Number(x.bid1Price || 0), ask1Price: Number(x.ask1Price || 0), price24hPcnt: Number(x.price24hPcnt || 0) }))
      .sort((a, b) => b.turnover24h - a.turnover24h).slice(0, n);
    return { markets };
  }
  if (name === 'get_bybit_market_snapshot') {
    const symbol = cleanBybitSymbol(args.symbol);
    const [ticker, book, m5, m15, h1, h4] = await Promise.all([
      bybitPublic('/v5/market/tickers', { category: 'spot', symbol }),
      bybitPublic('/v5/market/orderbook', { category: 'spot', symbol, limit: 25 }),
      bybitPublic('/v5/market/kline', { category: 'spot', symbol, interval: '5', limit: 60 }),
      bybitPublic('/v5/market/kline', { category: 'spot', symbol, interval: '15', limit: 60 }),
      bybitPublic('/v5/market/kline', { category: 'spot', symbol, interval: '60', limit: 60 }),
      bybitPublic('/v5/market/kline', { category: 'spot', symbol, interval: '240', limit: 60 }),
    ]);
    const mapK = (r) => (Array.isArray(r?.result?.list) ? r.result.list : []).map((k) => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), turnover: Number(k[6]) })).reverse();
    return { symbol, ticker: ticker?.result?.list?.[0] || {}, orderbook: book?.result || {}, candles: { m5: mapK(m5), m15: mapK(m15), h1: mapK(h1), h4: mapK(h4) } };
  }
  return null;
}

const DIRECT_BYBIT_READ_TOOLS = new Set([
  'get_bybit_connection_info', 'get_bybit_portfolio_summary', 'list_bybit_assets',
  'list_bybit_open_orders', 'list_bybit_recent_executions', 'list_bybit_usdc_markets', 'get_bybit_market_snapshot',
]);

function toolResult(id, structuredContent, text) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent } };
}

async function rpcOne(message) {
  if (!message || message.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  if (message.method === 'initialize') {
    const response = await v6Rpc(message);
    if (response?.result) {
      response.result.serverInfo = { name: 'chk-crypto-workspace', version: SERVER_VERSION };
      response.result.instructions = 'CHK Crypto Workspace v8. Binance and Bybit credentials are stored permanently in Render environment variables. MCP access is read/analysis only. Real Bybit Spot USDC orders can only be executed through the Android APK gateway after a proposal has been claimed by the user pressing CONFIRMER.';
    }
    return response;
  }
  if (message.method === 'tools/list') {
    const response = await v6Rpc(message);
    const tools = Array.isArray(response?.result?.tools) ? response.result.tools : [];
    if (response?.result) response.result.tools = tools.filter((tool) => !BLOCKED_WRITE_TOOLS.has(tool?.name));
    return response;
  }
  if (message.method === 'tools/call') {
    const name = String(message?.params?.name || '');
    const args = message?.params?.arguments || {};
    if (BLOCKED_WRITE_TOOLS.has(name)) {
      return { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'Écriture Bybit directe désactivée. Un ordre réel doit venir d’une proposition CHK Crypto puis du bouton CONFIRMER dans l’APK.' }] } };
    }
    if (DIRECT_BYBIT_READ_TOOLS.has(name)) {
      try {
        const data = await directBybitTool(name, args);
        return toolResult(message.id, data, `${name} • données Bybit EU live depuis les clés Render.`);
      } catch (error) {
        return { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: `Erreur Bybit Render : ${String(error.message || error).slice(0, 300)}` }] } };
      }
    }
    if (['get_portfolio_summary', 'list_assets', 'get_asset', 'get_latest_snapshot'].includes(name)) {
      try {
        const [binance, bybit] = await Promise.all([
          binanceConfigured ? loadBinanceWorkspace() : Promise.resolve(null),
          bybitConfigured ? loadBybitWorkspace() : Promise.resolve(null),
        ]);
        if (name === 'get_portfolio_summary') {
          return toolResult(message.id, {
            workspace: 'CHK Crypto Workspace', mode: 'BINANCE_PLUS_BYBIT_RENDER',
            binance: binance ? { totalEur: binance.portfolio.totalEur, totalUsdt: binance.portfolio.totalUsdt, assetCount: binance.portfolio.holdings.length, topAssets: binance.portfolio.holdings.slice(0, 8) } : null,
            bybit: bybit ? { totalEur: bybit.portfolio.totalEur, totalUsdt: bybit.portfolio.totalUsdt, assetCount: bybit.portfolio.holdings.length, topAssets: bybit.portfolio.holdings.slice(0, 8) } : null,
          }, 'Portefeuilles Binance + Bybit live depuis Render.');
        }
        if (name === 'list_assets') {
          const topN = Math.max(1, Math.min(50, Number(args.top_n || 20)));
          const assets = [
            ...(binance?.portfolio.holdings || []).slice(0, topN).map((a) => ({ exchange: 'BINANCE', ...a })),
            ...(bybit?.portfolio.holdings || []).slice(0, topN).map((a) => ({ exchange: 'BYBIT', ...a })),
          ];
          return toolResult(message.id, { assets }, `${assets.length} ligne(s) d’actifs Binance + Bybit live.`);
        }
        if (name === 'get_asset') {
          const symbol = String(args.symbol || '').toUpperCase();
          return toolResult(message.id, {
            symbol,
            binance: binance?.portfolio.holdings.find((a) => a.asset === symbol) || null,
            bybit: bybit?.portfolio.holdings.find((a) => a.asset === symbol) || null,
          }, `${symbol} recherché sur Binance et Bybit.`);
        }
        return toolResult(message.id, {
          workspace: 'CHK Crypto Workspace', mode: 'BINANCE_PLUS_BYBIT_RENDER',
          binance: binance ? { portfolio: binance.portfolio, historyText: binance.historyText } : null,
          bybit: bybit ? { portfolio: bybit.portfolio, historyText: bybit.historyText, apiInfoText: bybit.apiInfoText } : null,
        }, 'Snapshot complet Binance + Bybit live depuis Render.');
      } catch (error) {
        return { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: `Erreur Workspace Render : ${String(error.message || error).slice(0, 300)}` }] } };
      }
    }
  }
  return v6Rpc(message);
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
  let parsed;
  try { parsed = JSON.parse(await bodyText(req)); }
  catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const out = Array.isArray(parsed) ? (await Promise.all(parsed.map(rpcOne))).filter(Boolean) : await rpcOne(parsed);
  if ((Array.isArray(out) && !out.length) || out == null) { res.writeHead(202, { 'cache-control': 'no-store' }); return res.end(); }
  return json(res, 200, out, { 'mcp-protocol-version': '2025-06-18' });
}

async function proxy(req, res, pathname) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bodyText(req);
  const r = await v6Fetch(pathname, {
    method: req.method,
    headers: { ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}), accept: 'application/json' },
    body,
  });
  const text = await r.text();
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.pathname === '/apk/sync') return handleApkSync(req, res);
    if (url.pathname === '/apk/status') return handleApkStatus(req, res);
    if (url.pathname === '/apk/bybit/execute') return handleApkExecute(req, res);
    if (url.pathname === '/apk/bybit/reconcile') return handleApkReconcile(req, res);
    if (validMcpPath(url.pathname)) return handleMcp(req, res);
    if (url.pathname === '/health') {
      return json(res, 200, {
        ok: true, name: 'chk-crypto-workspace', version: SERVER_VERSION,
        credentialSource: 'render_environment',
        binanceConfigured, bybitConfigured,
        directMcpBybitWrites: false,
        apkConfirmedBybitWrites: true,
      });
    }
    if (url.pathname === '/') {
      return json(res, 200, {
        name: 'CHK Crypto Workspace MCP', version: SERVER_VERSION, status: 'online',
        credentialSource: 'render_environment',
        binanceConfigured, bybitConfigured,
        note: 'Clés permanentes sur Render. L’APK ne reçoit jamais les secrets. Les ordres Bybit réels exigent une proposition processing issue du bouton CONFIRMER.',
      });
    }
    return proxy(req, res, url.pathname + url.search);
  } catch (error) {
    console.error('request_error', error?.message || error);
    const status = Number(error?.httpStatus || 0) || 500;
    return json(res, status, { error: status === 403 ? 'forbidden' : 'server_error', message: String(error.message || error).slice(0, 300) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CHK Crypto Workspace v${SERVER_VERSION} listening on :${PORT}; credentials=Render env; v6 legacy on :${INTERNAL_PORT}`);
});
