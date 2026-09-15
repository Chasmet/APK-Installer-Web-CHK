import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL, URLSearchParams } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.V4_MCP_INTERNAL_PORT || (PORT + 1));
const EDGE_URL = process.env.SUPABASE_EDGE_URL;
const SUPABASE_MCP_TOKEN = process.env.SUPABASE_MCP_TOKEN;
const MCP_LINK_TOKEN = process.env.MCP_LINK_TOKEN;
const BYBIT_CREDENTIALS_KEY = process.env.BYBIT_CREDENTIALS_KEY;
const BYBIT_MAX_ORDER_USDC = Number(process.env.BYBIT_MAX_ORDER_USDC || 10);
const BYBIT = 'https://api.bybit.eu';
const RECV_WINDOW = '5000';
const SERVER_VERSION = '5.0.0';

for (const [name, value] of Object.entries({ EDGE_URL, SUPABASE_MCP_TOKEN, MCP_LINK_TOKEN, BYBIT_CREDENTIALS_KEY })) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const credentialKey = Buffer.from(String(BYBIT_CREDENTIALS_KEY), 'hex');
if (credentialKey.length !== 32) {
  console.error('BYBIT_CREDENTIALS_KEY must be 64 hexadecimal characters (32 bytes).');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const v4 = spawn(process.execPath, ['server-v4.mjs'], {
  cwd: here,
  env: { ...process.env, PORT: String(INTERNAL_PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
v4.on('exit', (code, signal) => console.error(`v4 MCP exited code=${code} signal=${signal}`));

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

function credentialsEdgeUrl() {
  const u = new URL(EDGE_URL);
  u.pathname = u.pathname.replace(/\/chk-binance-workspace-latest\/?$/, '/chk-bybit-credentials');
  return u.toString();
}

async function credentialsApi(payload) {
  const r = await fetch(credentialsEdgeUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'chk-crypto-workspace-mcp-v5',
      'x-chk-token': SUPABASE_MCP_TOKEN,
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text || 'null'); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`Bybit credential service ${r.status}: ${data?.error || text.slice(0, 180)}`);
  return data;
}

function decryptCredentials(record) {
  if (!record) throw new Error('Bybit n’est pas encore relié au Workspace. Reconnecte Bybit depuis l’APK.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plain);
  if (!parsed?.apiKey || !parsed?.apiSecret) throw new Error('Identifiants Bybit chiffrés invalides.');
  return { apiKey: String(parsed.apiKey), apiSecret: String(parsed.apiSecret) };
}

async function loadBybitCredentials() {
  const data = await credentialsApi({ action: 'get' });
  return decryptCredentials(data?.credential || null);
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

async function bybitRequest(method, pathname, paramsOrBody = {}) {
  const creds = await loadBybitCredentials();
  const timestamp = String(Date.now());
  let url = `${BYBIT}${pathname}`;
  let payload = '';
  let body;

  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(paramsOrBody)) {
      if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
    }
    payload = qs.toString();
    if (payload) url += `?${payload}`;
  } else {
    payload = JSON.stringify(paramsOrBody);
    body = payload;
  }

  const signature = hmac(creds.apiSecret, timestamp + creds.apiKey + RECV_WINDOW + payload);
  const r = await fetch(url, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'chk-crypto-workspace-mcp-v5',
      'X-BAPI-API-KEY': creds.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      'X-BAPI-SIGN': signature,
    },
    body,
  });

  const text = await r.text();
  let root;
  try { root = JSON.parse(text); } catch { throw new Error(`Bybit réponse invalide (${r.status})`); }
  if (!r.ok || Number(root.retCode || 0) !== 0) {
    throw new Error(`Bybit ${root.retCode ?? r.status}: ${root.retMsg || text.slice(0, 180)}`);
  }
  return root;
}

async function bybitPublic(pathname, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
  }
  const r = await fetch(`${BYBIT}${pathname}${qs.size ? `?${qs}` : ''}`, {
    headers: { accept: 'application/json', 'user-agent': 'chk-crypto-workspace-mcp-v5' },
  });
  const text = await r.text();
  let root;
  try { root = JSON.parse(text); } catch { throw new Error(`Bybit réponse invalide (${r.status})`); }
  if (!r.ok || Number(root.retCode || 0) !== 0) {
    throw new Error(`Bybit ${root.retCode ?? r.status}: ${root.retMsg || text.slice(0, 180)}`);
  }
  return root;
}

function cleanBybitSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 30);
  if (!symbol || !symbol.endsWith('USDC') || symbol === 'USDCUSDC') {
    throw new Error('Seules les paires Spot CRYPTO/USDC sont autorisées.');
  }
  return symbol;
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
  if (!Number.isFinite(st) || st <= 0) return { number: v, formatted: String(value) };
  const dec = decimalsFromStep(step);
  const floored = Math.floor((v + 1e-14) / st) * st;
  const formatted = floored.toFixed(dec);
  const number = Number(formatted);
  if (!(number > 0)) throw new Error(`Montant inférieur au pas minimum ${step}.`);
  return { number, formatted };
}

async function instrumentInfo(symbol) {
  const root = await bybitPublic('/v5/market/instruments-info', { category: 'spot', symbol });
  const item = root?.result?.list?.[0];
  if (!item) throw new Error(`Paire ${symbol} introuvable sur Bybit EU Spot.`);
  if (String(item.status || '').toLowerCase() !== 'trading') throw new Error(`${symbol} n’est pas actuellement tradable.`);
  return item;
}

async function walletCoins() {
  const root = await bybitRequest('GET', '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  const account = root?.result?.list?.[0];
  return Array.isArray(account?.coin) ? account.coin : [];
}

function usableCoinBalance(coin) {
  const wallet = Number(coin?.walletBalance || 0);
  const locked = Number(coin?.locked || 0);
  const spotBorrow = Number(coin?.spotBorrow || 0);
  return Math.max(0, wallet - locked - spotBorrow);
}

async function currentPrice(symbol) {
  const root = await bybitPublic('/v5/market/tickers', { category: 'spot', symbol });
  const ticker = root?.result?.list?.[0] || {};
  const bid = Number(ticker.bid1Price || 0);
  const ask = Number(ticker.ask1Price || 0);
  const last = Number(ticker.lastPrice || 0);
  return { bid, ask, last, reference: last || ((bid > 0 && ask > 0) ? (bid + ask) / 2 : bid || ask) };
}

const marketOrderTool = {
  name: 'place_bybit_market_order',
  title: 'Placer un ordre MARKET Spot Bybit',
  description: 'REAL MONEY ACTION. Place a real Bybit EU Spot MARKET order on a CRYPTO/USDC pair only after explicit user confirmation of the exact pair, side and amount. For Buy, amount is USDC to spend. For Sell, amount is base-coin quantity to sell. No leverage, Futures, transfer or withdrawal. The order is capped by BYBIT_MAX_ORDER_USDC.',
  inputSchema: {
    type: 'object',
    properties: {
      symbol: { type: 'string', minLength: 5, maxLength: 30 },
      side: { type: 'string', enum: ['Buy', 'Sell'] },
      amount: { type: 'number', exclusiveMinimum: 0, description: 'Buy: USDC to spend. Sell: base-coin quantity to sell.' },
      confirmed: { type: 'boolean', description: 'Must be true only after explicit user approval of this exact real-money order.' },
    },
    required: ['symbol', 'side', 'amount', 'confirmed'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
};

async function placeMarketOrder(args = {}) {
  if (args.confirmed !== true) throw new Error('Confirmation explicite requise avant tout ordre réel.');

  const symbol = cleanBybitSymbol(args.symbol);
  const side = args.side === 'Buy' ? 'Buy' : args.side === 'Sell' ? 'Sell' : null;
  if (!side) throw new Error('Side doit être Buy ou Sell.');
  const amount = Number(args.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('Montant invalide.');

  const info = await instrumentInfo(symbol);
  const coins = await walletCoins();
  const baseCoin = symbol.slice(0, -4);
  const minOrderAmt = Number(info?.lotSizeFilter?.minOrderAmt || 0);
  const minOrderQty = Number(info?.lotSizeFilter?.minOrderQty || 0);

  let qty;
  let marketUnit;
  let estimatedNotionalUsdc;

  if (side === 'Buy') {
    const usdc = coins.find((c) => c.coin === 'USDC');
    const available = usableCoinBalance(usdc);
    const quotePrecision = Number(info?.lotSizeFilter?.quotePrecision || 0);
    const quoteStep = quotePrecision > 0 ? String(quotePrecision) : '0.000001';
    const q = floorToStep(amount, quoteStep);
    qty = q.formatted;
    marketUnit = 'quoteCoin';
    estimatedNotionalUsdc = q.number;

    if (q.number > BYBIT_MAX_ORDER_USDC + 1e-9) {
      throw new Error(`Ordre refusé: ${q.number.toFixed(4)} USDC dépasse le plafond de ${BYBIT_MAX_ORDER_USDC} USDC.`);
    }
    if (minOrderAmt > 0 && q.number + 1e-12 < minOrderAmt) {
      throw new Error(`Ordre trop petit: minimum Bybit ${minOrderAmt} USDC.`);
    }
    if (available + 1e-9 < q.number) {
      throw new Error(`Solde USDC disponible insuffisant (${available.toFixed(4)} USDC).`);
    }
  } else {
    const qtyStep = info?.lotSizeFilter?.qtyStep || '0';
    const q = floorToStep(amount, qtyStep);
    qty = q.formatted;
    marketUnit = 'baseCoin';

    if (minOrderQty > 0 && q.number + 1e-12 < minOrderQty) {
      throw new Error(`Quantité trop petite: minimum Bybit ${minOrderQty} ${baseCoin}.`);
    }
    const base = coins.find((c) => c.coin === baseCoin);
    const available = usableCoinBalance(base);
    if (available + 1e-12 < q.number) {
      throw new Error(`Solde ${baseCoin} disponible insuffisant (${available}).`);
    }

    const px = await currentPrice(symbol);
    if (!(px.reference > 0)) throw new Error(`Prix ${symbol} indisponible pour le contrôle de taille.`);
    estimatedNotionalUsdc = q.number * px.reference;
    if (estimatedNotionalUsdc > BYBIT_MAX_ORDER_USDC + 1e-9) {
      throw new Error(`Ordre refusé: valeur estimée ${estimatedNotionalUsdc.toFixed(4)} USDC dépasse le plafond de ${BYBIT_MAX_ORDER_USDC} USDC.`);
    }
    if (minOrderAmt > 0 && estimatedNotionalUsdc + 1e-12 < minOrderAmt) {
      throw new Error(`Ordre trop petit: valeur estimée sous le minimum Bybit ${minOrderAmt} USDC.`);
    }
  }

  const orderLinkId = `chk-mkt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const body = {
    category: 'spot',
    symbol,
    side,
    orderType: 'Market',
    qty,
    marketUnit,
    timeInForce: 'IOC',
    isLeverage: 0,
    orderFilter: 'Order',
    orderLinkId,
  };

  const root = await bybitRequest('POST', '/v5/order/create', body);
  return {
    content: [{ type: 'text', text: `Ordre MARKET ${side} ${symbol} envoyé à Bybit EU.` }],
    structuredContent: {
      ok: true,
      realOrder: true,
      symbol,
      side,
      amount,
      amountUnit: side === 'Buy' ? 'USDC' : baseCoin,
      estimatedNotionalUsdc,
      orderId: root?.result?.orderId || null,
      orderLinkId: root?.result?.orderLinkId || orderLinkId,
      acknowledgement: 'Bybit a accepté la création. Vérifier ensuite l’exécution réelle via les exécutions Spot.',
    },
  };
}

async function v4Rpc(message) {
  const url = `http://127.0.0.1:${INTERNAL_PORT}/mcp/${encodeURIComponent(MCP_LINK_TOKEN)}`;
  let lastError;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' },
        body: JSON.stringify(message),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`v4 MCP ${r.status}: ${text.slice(0, 180)}`);
      return text ? JSON.parse(text) : null;
    } catch (error) {
      lastError = error;
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError || new Error('v4 MCP indisponible');
}

async function proxyHttpToV4(req, res, pathname) {
  const target = `http://127.0.0.1:${INTERNAL_PORT}${pathname}`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bodyText(req);
  const r = await fetch(target, {
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
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function rpcOne(message) {
  if (!message || message.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }

  if (message.method === 'tools/list') {
    const baseResponse = await v4Rpc(message);
    const tools = Array.isArray(baseResponse?.result?.tools) ? baseResponse.result.tools : [];
    const withoutDuplicate = tools.filter((t) => t?.name !== marketOrderTool.name);
    return { jsonrpc: '2.0', id: message.id, result: { tools: [...withoutDuplicate, marketOrderTool] } };
  }

  if (message.method === 'initialize') {
    const response = await v4Rpc(message);
    if (response?.result) {
      response.result.serverInfo = { name: 'chk-crypto-workspace', version: SERVER_VERSION };
      response.result.instructions = 'Persistent CHK Crypto Workspace. Binance remains read/analysis/alerts. Bybit EU exposes live Spot portfolio/market tools plus real Spot LIMIT and MARKET orders on CRYPTO/USDC pairs, only after explicit confirmation. No leverage, Futures, transfer or withdrawal.';
    }
    return response;
  }

  if (message.method === 'tools/call' && message.params?.name === marketOrderTool.name) {
    try {
      return { jsonrpc: '2.0', id: message.id, result: await placeMarketOrder(message.params?.arguments || {}) };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: { isError: true, content: [{ type: 'text', text: `Erreur Bybit MARKET : ${String(error.message || error).slice(0, 320)}` }] },
      };
    }
  }

  if (message.method === 'tools/call' && message.params?.name === 'get_workspace_info') {
    const response = await v4Rpc(message);
    if (response?.result?.structuredContent) {
      const current = response.result.structuredContent;
      const capabilities = Array.isArray(current.capabilities) ? current.capabilities : [];
      response.result.structuredContent = {
        ...current,
        serverVersion: SERVER_VERSION,
        capabilities: [...new Set([...capabilities, 'Bybit EU Spot MARKET order placement after explicit confirmation'])],
        note: 'Binance reste en lecture/analyse/alertes. Bybit EU permet lecture live + ordres Spot LIMIT et MARKET CRYPTO/USDC confirmés. Aucun levier, Futures, transfert ou retrait.',
      };
      response.result.content = [{ type: 'text', text: 'CHK Crypto Workspace v5 : Binance + Bybit EU actifs. LIMIT et MARKET Spot Bybit disponibles après confirmation explicite.' }];
    }
    return response;
  }

  return v4Rpc(message);
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
  let parsed;
  try { parsed = JSON.parse(await bodyText(req)); }
  catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

  const out = Array.isArray(parsed)
    ? (await Promise.all(parsed.map(rpcOne))).filter(Boolean)
    : await rpcOne(parsed);

  if ((Array.isArray(out) && !out.length) || out == null) {
    res.writeHead(202, { 'cache-control': 'no-store' });
    return res.end();
  }
  return json(res, 200, out, { 'mcp-protocol-version': '2025-06-18' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);

    if (url.pathname === '/pair/bybit') {
      return proxyHttpToV4(req, res, '/pair/bybit');
    }

    if (url.pathname === '/health') {
      let v4Health = {};
      try {
        const r = await fetch(`http://127.0.0.1:${INTERNAL_PORT}/health`);
        v4Health = await r.json();
      } catch {}
      return json(res, 200, {
        ok: true,
        name: 'chk-crypto-workspace',
        version: SERVER_VERSION,
        features: [...new Set([...(v4Health.features || []), 'bybit-spot-market-write'])],
        bybit: v4Health.bybit || null,
      });
    }

    if (validMcpPath(url.pathname)) return handleMcp(req, res);

    if (url.pathname === '/') {
      return json(res, 200, {
        name: 'CHK Crypto Workspace MCP',
        version: SERVER_VERSION,
        status: 'online',
        bybit: 'Spot LIMIT + MARKET enabled after explicit confirmation',
        restrictions: ['Spot only', 'USDC pairs only', 'No leverage', 'No Futures', 'No transfer', 'No withdrawal', `Max ${BYBIT_MAX_ORDER_USDC} USDC per order`],
      });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('request_error', error?.message || error);
    return json(res, 500, { error: 'server_error', message: String(error.message || error).slice(0, 240) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CHK Crypto Workspace MCP v5 listening on :${PORT}; v4 base on :${INTERNAL_PORT}`);
});
