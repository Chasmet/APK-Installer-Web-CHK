import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL, URLSearchParams } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.BASE_MCP_INTERNAL_PORT || (PORT + 1));
const EDGE_URL = process.env.SUPABASE_EDGE_URL;
const SUPABASE_MCP_TOKEN = process.env.SUPABASE_MCP_TOKEN;
const MCP_LINK_TOKEN = process.env.MCP_LINK_TOKEN;
const BYBIT_CREDENTIALS_KEY = process.env.BYBIT_CREDENTIALS_KEY;
const BYBIT_MAX_ORDER_USDC = Number(process.env.BYBIT_MAX_ORDER_USDC || 10);
const BYBIT = 'https://api.bybit.eu';
const RECV_WINDOW = '5000';

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
const base = spawn(process.execPath, ['server.mjs'], {
  cwd: here,
  env: { ...process.env, PORT: String(INTERNAL_PORT) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
base.on('exit', (code, signal) => console.error(`Base Binance MCP exited code=${code} signal=${signal}`));

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

async function bodyText(req, max = 100_000) {
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

async function credentialsApi(payload, serverAuth = false) {
  const r = await fetch(credentialsEdgeUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'chk-crypto-workspace-mcp',
      ...(serverAuth ? {'x-chk-token': SUPABASE_MCP_TOKEN} : {}),
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text || 'null'); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`Bybit credential service ${r.status}: ${data?.error || text.slice(0,180)}`);
  return data;
}

function encryptCredentials(apiKey, apiSecret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey, iv);
  const plain = Buffer.from(JSON.stringify({ apiKey, apiSecret }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decryptCredentials(record) {
  if (!record) throw new Error('Bybit n’est pas encore relié au Workspace. Ouvre Réglages Bybit dans l’APK et appuie sur « Connecter au Workspace ».' );
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.auth_tag, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const parsed = JSON.parse(plain);
  if (!parsed?.apiKey || !parsed?.apiSecret) throw new Error('Identifiants Bybit chiffrés invalides.');
  return { apiKey: String(parsed.apiKey), apiSecret: String(parsed.apiSecret), record };
}

async function loadBybitCredentials() {
  const data = await credentialsApi({ action: 'get' }, true);
  return decryptCredentials(data?.credential || null);
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

async function bybitPublic(pathname, params = {}) {
  const qs = new URLSearchParams();
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
  const url = `${BYBIT}${pathname}${qs.size ? `?${qs}` : ''}`;
  const r = await fetch(url, { headers: { accept:'application/json', 'user-agent':'chk-crypto-workspace-mcp' } });
  const text = await r.text();
  let root;
  try { root = JSON.parse(text); } catch { throw new Error(`Bybit réponse invalide (${r.status})`); }
  if (!r.ok || Number(root.retCode || 0) !== 0) throw new Error(`Bybit ${root.retCode ?? r.status}: ${root.retMsg || text.slice(0,160)}`);
  return root;
}

async function bybitSigned(method, pathname, paramsOrBody = {}, suppliedCreds = null) {
  const creds = suppliedCreds || await loadBybitCredentials();
  const timestamp = String(Date.now());
  let url = `${BYBIT}${pathname}`;
  let payload = '';
  let body = undefined;
  if (method === 'GET') {
    const qs = new URLSearchParams();
    for (const [k,v] of Object.entries(paramsOrBody)) if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
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
      accept:'application/json',
      'content-type':'application/json',
      'user-agent':'chk-crypto-workspace-mcp',
      'X-BAPI-API-KEY':creds.apiKey,
      'X-BAPI-TIMESTAMP':timestamp,
      'X-BAPI-RECV-WINDOW':RECV_WINDOW,
      'X-BAPI-SIGN':signature,
    },
    body,
  });
  const text = await r.text();
  let root;
  try { root = JSON.parse(text); } catch { throw new Error(`Bybit réponse invalide (${r.status})`); }
  if (!r.ok || Number(root.retCode || 0) !== 0) throw new Error(`Bybit ${root.retCode ?? r.status}: ${root.retMsg || text.slice(0,180)}`);
  return root;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function cleanBybitSymbol(value) {
  const s = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0,30);
  if (!s || !s.endsWith('USDC') || s === 'USDCUSDC') throw new Error('Seules les paires Spot CRYPTO/USDC sont autorisées.');
  return s;
}

function decimalsFromStep(step) {
  const s = String(step || '');
  if (s.includes('e-')) return Math.min(12, Number(s.split('e-')[1]) || 0);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.slice(i + 1).replace(/0+$/,'').length;
}

function alignedValue(value, step) {
  const v = Number(value), st = Number(step);
  if (!Number.isFinite(v) || v <= 0) throw new Error('Valeur numérique invalide.');
  if (!Number.isFinite(st) || st <= 0) return { ok:true, formatted:String(value), suggested:value };
  const units = v / st;
  const nearest = Math.round(units) * st;
  const ok = Math.abs(v - nearest) <= Math.max(1e-12, st * 1e-8);
  const dec = decimalsFromStep(step);
  return { ok, formatted: nearest.toFixed(dec), suggested: Number(nearest.toFixed(dec)) };
}

async function instrumentInfo(symbol) {
  const root = await bybitPublic('/v5/market/instruments-info', { category:'spot', symbol });
  const item = root?.result?.list?.[0];
  if (!item) throw new Error(`Paire ${symbol} introuvable sur Bybit EU Spot.`);
  if (String(item.status || '').toLowerCase() !== 'trading') throw new Error(`${symbol} n’est pas actuellement en statut Trading.`);
  return item;
}

async function walletCoins() {
  const root = await bybitSigned('GET','/v5/account/wallet-balance',{accountType:'UNIFIED'});
  const account = root?.result?.list?.[0];
  const coins = Array.isArray(account?.coin) ? account.coin : [];
  return { account, coins };
}

function usableCoinBalance(coin) {
  const wallet = Number(coin?.walletBalance || 0);
  const locked = Number(coin?.locked || 0);
  const spotBorrow = Number(coin?.spotBorrow || 0);
  return Math.max(0, wallet - locked - spotBorrow);
}

async function bybitConnectionInfo() {
  try {
    const creds = await loadBybitCredentials();
    const root = await bybitSigned('GET','/v5/user/query-api',{},creds);
    const r = root?.result || {};
    const spot = Array.isArray(r?.permissions?.Spot) ? r.permissions.Spot : [];
    return {
      connected:true,
      credentialStoredAt:creds.record?.updated_at || null,
      readOnly:Number(r.readOnly) === 1,
      spotPermissions:spot,
      canSpotTrade:Number(r.readOnly) === 0 && spot.includes('SpotTrade'),
      apiKeyFingerprint:creds.record?.api_key_fingerprint || null,
      note:'Le Workspace n’expose ni retrait, ni transfert, ni Futures. Les écritures sont limitées aux ordres Spot Limit USDC et à leur annulation.'
    };
  } catch (error) {
    return { connected:false, canSpotTrade:false, error:String(error.message || error) };
  }
}

async function handlePairBybit(req, res) {
  if (req.method !== 'POST') return json(res,405,{error:'method_not_allowed'},{allow:'POST'});
  let body;
  try { body = JSON.parse(await bodyText(req, 50_000)); }
  catch { return json(res,400,{error:'invalid_json'}); }
  const deviceId = String(body?.deviceId || '').trim();
  const deviceSecret = String(body?.deviceSecret || '');
  const apiKey = String(body?.apiKey || '').trim();
  const apiSecret = String(body?.apiSecret || '').trim();
  if (apiKey.length < 8 || apiKey.length > 256 || apiSecret.length < 8 || apiSecret.length > 512) return json(res,400,{error:'invalid_bybit_credentials'});
  try {
    await credentialsApi({ action:'verify_device', deviceId, deviceSecret }, false);
    const root = await bybitSigned('GET','/v5/user/query-api',{}, {apiKey, apiSecret});
    const info = root?.result || {};
    const spot = Array.isArray(info?.permissions?.Spot) ? info.permissions.Spot : [];
    if (Number(info.readOnly) !== 0 || !spot.includes('SpotTrade')) {
      return json(res,403,{error:'spot_trade_permission_required',readOnly:info.readOnly,spotPermissions:spot});
    }
    const encrypted = encryptCredentials(apiKey, apiSecret);
    const stored = await credentialsApi({
      action:'store',
      deviceId,
      apiKeyFingerprint:sha256(apiKey),
      ...encrypted,
    }, true);
    return json(res,200,{ok:true,connected:true,canSpotTrade:true,spotPermissions:spot,storedAt:stored.updatedAt || null});
  } catch (error) {
    console.error('pair_bybit', error?.message || error);
    return json(res,400,{error:'pair_failed',message:String(error.message || error).slice(0,240)});
  }
}

const readAnn = {readOnlyHint:true,destructiveHint:false,openWorldHint:true,idempotentHint:true};
const tradeAnn = {readOnlyHint:false,destructiveHint:true,openWorldHint:true,idempotentHint:false};
const cancelAnn = {readOnlyHint:false,destructiveHint:true,openWorldHint:true,idempotentHint:true};

const bybitTools = [
  {name:'get_bybit_connection_info',title:'État connexion Bybit EU',description:'Use this to verify whether Bybit EU is securely paired to the CHK Workspace and whether the API key has SpotTrade permission.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:readAnn},
  {name:'get_bybit_portfolio_summary',title:'Résumé portefeuille Bybit',description:'Use this for a live Bybit EU Unified wallet summary and largest positive balances.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:readAnn},
  {name:'list_bybit_assets',title:'Lister actifs Bybit',description:'Use this to list live Bybit EU wallet assets and balances.',inputSchema:{type:'object',properties:{top_n:{type:'integer',minimum:1,maximum:50,default:20}},additionalProperties:false},annotations:readAnn},
  {name:'list_bybit_open_orders',title:'Ordres Spot Bybit ouverts',description:'Use this to inspect current open Spot orders on Bybit EU. If symbol is supplied it must be a CRYPTO/USDC pair.',inputSchema:{type:'object',properties:{symbol:{type:'string',maxLength:30},limit:{type:'integer',minimum:1,maximum:50,default:20}},additionalProperties:false},annotations:readAnn},
  {name:'list_bybit_recent_executions',title:'Exécutions Spot Bybit récentes',description:'Use this to read recent live Spot executions on Bybit EU.',inputSchema:{type:'object',properties:{symbol:{type:'string',maxLength:30},limit:{type:'integer',minimum:1,maximum:100,default:30}},additionalProperties:false},annotations:readAnn},
  {name:'list_bybit_usdc_markets',title:'Marchés Bybit USDC',description:'Use this to discover liquid Bybit EU Spot CRYPTO/USDC markets. Returns the highest 24h turnover pairs first.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:100,default:30}},additionalProperties:false},annotations:readAnn},
  {name:'get_bybit_market_snapshot',title:'Données marché Bybit USDC',description:'Use this before considering a trade. Returns current ticker, order-book spread and recent 5m/15m/1h/4h candles for one Bybit EU Spot USDC pair.',inputSchema:{type:'object',properties:{symbol:{type:'string',minLength:5,maxLength:30}},required:['symbol'],additionalProperties:false},annotations:readAnn},
  {name:'place_bybit_limit_order',title:'Placer un ordre LIMIT Spot Bybit',description:'REAL MONEY ACTION. Use only after the user explicitly confirms the exact Bybit EU Spot USDC pair, side, quantity and limit price. Never call from analysis alone. This tool only permits Spot Limit, no leverage, no Market, no Futures, no transfer and no withdrawal. A single order is capped by BYBIT_MAX_ORDER_USDC.',inputSchema:{type:'object',properties:{symbol:{type:'string',minLength:5,maxLength:30},side:{type:'string',enum:['Buy','Sell']},quantity:{type:'number',exclusiveMinimum:0},price:{type:'number',exclusiveMinimum:0},confirmed:{type:'boolean',description:'Must be true only after explicit user approval of this exact order.'}},required:['symbol','side','quantity','price','confirmed'],additionalProperties:false},annotations:tradeAnn},
  {name:'cancel_bybit_order',title:'Annuler un ordre Bybit',description:'Use only when the user explicitly asks to cancel a specific Bybit EU Spot USDC order.',inputSchema:{type:'object',properties:{symbol:{type:'string',minLength:5,maxLength:30},order_id:{type:'string',maxLength:80},order_link_id:{type:'string',maxLength:80},confirmed:{type:'boolean'}},required:['symbol','confirmed'],additionalProperties:false},annotations:cancelAnn},
];

function isBybitTool(name) { return bybitTools.some(t => t.name === name); }

async function callBybitTool(name, args = {}) {
  if (name === 'get_bybit_connection_info') {
    const info = await bybitConnectionInfo();
    return {content:[{type:'text',text:info.connected?'Bybit EU est relié au Workspace.':'Bybit EU n’est pas encore relié au Workspace.'}],structuredContent:info};
  }
  if (name === 'get_bybit_portfolio_summary' || name === 'list_bybit_assets') {
    const {account, coins} = await walletCoins();
    const assets = coins
      .map(c => ({coin:c.coin,walletBalance:Number(c.walletBalance||0),available:usableCoinBalance(c),usdValue:Number(c.usdValue||0),locked:Number(c.locked||0)}))
      .filter(a => a.walletBalance > 0 || a.usdValue > 0)
      .sort((a,b)=>b.usdValue-a.usdValue);
    if (name === 'list_bybit_assets') {
      const n = Math.max(1,Math.min(50,Number(args.top_n || 20)));
      return {content:[{type:'text',text:`${Math.min(n,assets.length)} actif(s) Bybit.`}],structuredContent:{assets:assets.slice(0,n)}};
    }
    return {content:[{type:'text',text:'Résumé live du portefeuille Bybit EU.'}],structuredContent:{totalEquity:Number(account?.totalEquity||0),totalWalletBalance:Number(account?.totalWalletBalance||0),totalAvailableBalance:Number(account?.totalAvailableBalance||0),assetCount:assets.length,topAssets:assets.slice(0,8)}};
  }
  if (name === 'list_bybit_open_orders') {
    const params = {category:'spot',limit:Math.max(1,Math.min(50,Number(args.limit||20)))};
    if (args.symbol) params.symbol = cleanBybitSymbol(args.symbol);
    const root = await bybitSigned('GET','/v5/order/realtime',params);
    const orders = Array.isArray(root?.result?.list) ? root.result.list : [];
    return {content:[{type:'text',text:`${orders.length} ordre(s) Spot Bybit ouvert(s).`}],structuredContent:{orders}};
  }
  if (name === 'list_bybit_recent_executions') {
    const params = {category:'spot',limit:Math.max(1,Math.min(100,Number(args.limit||30)))};
    if (args.symbol) params.symbol = cleanBybitSymbol(args.symbol);
    const root = await bybitSigned('GET','/v5/execution/list',params);
    const executions = Array.isArray(root?.result?.list) ? root.result.list : [];
    return {content:[{type:'text',text:`${executions.length} exécution(s) Spot Bybit récente(s).`}],structuredContent:{executions}};
  }
  if (name === 'list_bybit_usdc_markets') {
    const root = await bybitPublic('/v5/market/tickers',{category:'spot'});
    const n = Math.max(1,Math.min(100,Number(args.limit||30)));
    const markets = (Array.isArray(root?.result?.list)?root.result.list:[])
      .filter(x => String(x.symbol||'').endsWith('USDC') && !String(x.symbol||'').startsWith('USDC'))
      .map(x => ({symbol:x.symbol,lastPrice:Number(x.lastPrice||0),price24hPcnt:Number(x.price24hPcnt||0),turnover24h:Number(x.turnover24h||0),volume24h:Number(x.volume24h||0),bid1Price:Number(x.bid1Price||0),ask1Price:Number(x.ask1Price||0)}))
      .sort((a,b)=>b.turnover24h-a.turnover24h)
      .slice(0,n);
    return {content:[{type:'text',text:`${markets.length} marché(s) Bybit USDC classé(s) par turnover 24h.`}],structuredContent:{markets}};
  }
  if (name === 'get_bybit_market_snapshot') {
    const symbol = cleanBybitSymbol(args.symbol);
    const [tickerRoot,bookRoot,k5,k15,k60,k240] = await Promise.all([
      bybitPublic('/v5/market/tickers',{category:'spot',symbol}),
      bybitPublic('/v5/market/orderbook',{category:'spot',symbol,limit:25}),
      bybitPublic('/v5/market/kline',{category:'spot',symbol,interval:'5',limit:60}),
      bybitPublic('/v5/market/kline',{category:'spot',symbol,interval:'15',limit:60}),
      bybitPublic('/v5/market/kline',{category:'spot',symbol,interval:'60',limit:60}),
      bybitPublic('/v5/market/kline',{category:'spot',symbol,interval:'240',limit:60}),
    ]);
    const ticker = tickerRoot?.result?.list?.[0] || {};
    const bid = Number(ticker.bid1Price||0), ask = Number(ticker.ask1Price||0);
    const mid = bid>0&&ask>0?(bid+ask)/2:Number(ticker.lastPrice||0);
    const spreadPct = mid>0&&ask>=bid?((ask-bid)/mid)*100:null;
    const mapK = r => (Array.isArray(r?.result?.list)?r.result.list:[]).map(k=>({time:Number(k[0]),open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),volume:Number(k[5]),turnover:Number(k[6])})).reverse();
    return {content:[{type:'text',text:`Snapshot marché ${symbol} prêt pour analyse.`}],structuredContent:{symbol,ticker,spreadPct,orderbook:bookRoot?.result||{},candles:{m5:mapK(k5),m15:mapK(k15),h1:mapK(k60),h4:mapK(k240)}}};
  }
  if (name === 'place_bybit_limit_order') {
    if (args.confirmed !== true) throw new Error('Confirmation explicite requise avant tout ordre réel.');
    const symbol = cleanBybitSymbol(args.symbol);
    const side = args.side === 'Sell' ? 'Sell' : args.side === 'Buy' ? 'Buy' : null;
    if (!side) throw new Error('Side doit être Buy ou Sell.');
    const qty = Number(args.quantity), price = Number(args.price);
    if (!Number.isFinite(qty)||qty<=0||!Number.isFinite(price)||price<=0) throw new Error('Quantité ou prix invalide.');
    const info = await instrumentInfo(symbol);
    const qtyStep = info?.lotSizeFilter?.qtyStep || '0';
    const tickSize = info?.priceFilter?.tickSize || '0';
    const q = alignedValue(qty,qtyStep), p = alignedValue(price,tickSize);
    if (!q.ok) throw new Error(`Quantité non alignée au pas Bybit ${qtyStep}. Valeur valide proche: ${q.suggested}`);
    if (!p.ok) throw new Error(`Prix non aligné au tick Bybit ${tickSize}. Valeur valide proche: ${p.suggested}`);
    const notional = q.suggested * p.suggested;
    if (notional > BYBIT_MAX_ORDER_USDC + 1e-9) throw new Error(`Ordre refusé: ${notional.toFixed(4)} USDC dépasse le plafond de ${BYBIT_MAX_ORDER_USDC} USDC.`);
    const minAmt = Number(info?.lotSizeFilter?.minOrderAmt || 0);
    const minQty = Number(info?.lotSizeFilter?.minOrderQty || 0);
    if (minAmt > 0 && notional + 1e-12 < minAmt) throw new Error(`Ordre trop petit: minimum Bybit ${minAmt} USDC.`);
    if (minQty > 0 && q.suggested + 1e-12 < minQty) throw new Error(`Quantité trop petite: minimum Bybit ${minQty}.`);
    const {coins} = await walletCoins();
    if (side === 'Buy') {
      const usdc = coins.find(c=>c.coin==='USDC');
      if (usableCoinBalance(usdc) + 1e-9 < notional) throw new Error(`Solde USDC disponible insuffisant (${usableCoinBalance(usdc).toFixed(4)} USDC).`);
    } else {
      const baseCoin = symbol.slice(0,-4);
      const coin = coins.find(c=>c.coin===baseCoin);
      if (usableCoinBalance(coin) + 1e-12 < q.suggested) throw new Error(`Solde ${baseCoin} disponible insuffisant (${usableCoinBalance(coin)}).`);
    }
    const orderLinkId = `chk-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const body = {category:'spot',symbol,side,orderType:'Limit',qty:q.formatted,price:p.formatted,timeInForce:'GTC',isLeverage:0,orderLinkId};
    const root = await bybitSigned('POST','/v5/order/create',body);
    return {content:[{type:'text',text:`Ordre LIMIT ${side} ${symbol} envoyé à Bybit EU.`}],structuredContent:{ok:true,realOrder:true,symbol,side,quantity:q.suggested,price:p.suggested,notionalUsdc:notional,orderId:root?.result?.orderId||null,orderLinkId:root?.result?.orderLinkId||orderLinkId}};
  }
  if (name === 'cancel_bybit_order') {
    if (args.confirmed !== true) throw new Error('Confirmation explicite requise pour annuler cet ordre.');
    const symbol = cleanBybitSymbol(args.symbol);
    const orderId = String(args.order_id || '').trim();
    const orderLinkId = String(args.order_link_id || '').trim();
    if (!orderId && !orderLinkId) throw new Error('order_id ou order_link_id requis.');
    const body = {category:'spot',symbol,...(orderId?{orderId}:{orderLinkId})};
    const root = await bybitSigned('POST','/v5/order/cancel',body);
    return {content:[{type:'text',text:`Ordre ${symbol} annulé sur Bybit EU.`}],structuredContent:{ok:true,symbol,orderId:root?.result?.orderId||orderId||null,orderLinkId:root?.result?.orderLinkId||orderLinkId||null}};
  }
  throw new Error(`Outil Bybit inconnu: ${name}`);
}

async function baseRpc(message) {
  const url = `http://127.0.0.1:${INTERNAL_PORT}/mcp/${encodeURIComponent(MCP_LINK_TOKEN)}`;
  let lastError;
  for (let attempt=0; attempt<8; attempt++) {
    try {
      const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18'},body:JSON.stringify(message)});
      const text = await r.text();
      if (!r.ok) throw new Error(`Base MCP ${r.status}: ${text.slice(0,160)}`);
      return text ? JSON.parse(text) : null;
    } catch (error) {
      lastError = error;
      if (attempt < 7) await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
  throw lastError || new Error('Base MCP indisponible');
}

async function rpcOne(message) {
  if (!message || message.jsonrpc !== '2.0') return {jsonrpc:'2.0',id:message?.id??null,error:{code:-32600,message:'Invalid Request'}};
  if (message.method === 'tools/list') {
    const baseResponse = await baseRpc(message);
    const baseTools = baseResponse?.result?.tools || [];
    return {jsonrpc:'2.0',id:message.id,result:{tools:[...baseTools,...bybitTools]}};
  }
  if (message.method === 'initialize') {
    const baseResponse = await baseRpc(message);
    if (baseResponse?.result) {
      baseResponse.result.serverInfo = {name:'chk-crypto-workspace',version:'4.0.0'};
      baseResponse.result.instructions = 'Persistent CHK Crypto Workspace. Binance remains read/analysis/alerts. Bybit EU can read live Spot data and, only after explicit user confirmation, place or cancel real Spot LIMIT orders on CRYPTO/USDC pairs. No Market, leverage, Futures, transfers or withdrawals are exposed.';
    }
    return baseResponse;
  }
  if (message.method === 'tools/call' && isBybitTool(message.params?.name)) {
    try {
      return {jsonrpc:'2.0',id:message.id,result:await callBybitTool(message.params.name,message.params?.arguments||{})};
    } catch (error) {
      return {jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:`Erreur Bybit Workspace : ${String(error.message||error).slice(0,300)}`}]}};
    }
  }
  return await baseRpc(message);
}

async function handleMcp(req,res) {
  if (req.method !== 'POST') return json(res,405,{error:'method_not_allowed'},{allow:'POST'});
  let parsed;
  try { parsed = JSON.parse(await bodyText(req,1_000_000)); }
  catch { return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}); }
  const out = Array.isArray(parsed)
    ? (await Promise.all(parsed.map(rpcOne))).filter(Boolean)
    : await rpcOne(parsed);
  if ((Array.isArray(out)&&!out.length)||out==null) { res.writeHead(202,{'cache-control':'no-store'}); return res.end(); }
  return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});
}

const server = http.createServer(async (req,res)=>{
  try {
    const url = new URL(req.url,`https://${req.headers.host}`);
    if (url.pathname === '/pair/bybit') return handlePairBybit(req,res);
    if (url.pathname === '/health') {
      const bybit = await bybitConnectionInfo();
      return json(res,200,{ok:true,name:'chk-crypto-workspace',version:'4.0.0',features:['binance-portfolio','analysis','alerts','bybit-live','bybit-spot-limit-write'],bybit:{connected:bybit.connected,canSpotTrade:bybit.canSpotTrade}});
    }
    if (validMcpPath(url.pathname)) return handleMcp(req,res);
    if (url.pathname === '/') {
      const bybit = await bybitConnectionInfo();
      return json(res,200,{name:'CHK Crypto Workspace MCP',version:'4.0.0',status:'online',bybit:{connected:bybit.connected,canSpotTrade:bybit.canSpotTrade},restrictions:['Spot only','USDC pairs only','Limit only','No leverage','No transfer','No withdrawal',`Max ${BYBIT_MAX_ORDER_USDC} USDC per order`]});
    }
    return json(res,404,{error:'not_found'});
  } catch (error) {
    console.error('request_error',error?.message||error);
    return json(res,500,{error:'server_error'});
  }
});

server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto Workspace MCP v4 listening on :${PORT}; Binance base on :${INTERNAL_PORT}`));
