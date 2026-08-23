import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL, URLSearchParams } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_PORT = Number(process.env.V10_UPSTREAM_PORT || (PORT + 10));
const MCP_LINK_TOKEN = String(process.env.MCP_LINK_TOKEN || '');
const BINANCE_API_KEY = String(process.env.BINANCE_API_KEY || '').trim();
const BINANCE_API_SECRET = String(process.env.BINANCE_API_SECRET || '').trim();
const BYBIT_API_KEY = String(process.env.BYBIT_API_KEY || '').trim();
const BYBIT_API_SECRET = String(process.env.BYBIT_API_SECRET || '').trim();
const SERVER_VERSION = '10.0.0';
const BINANCE = 'https://api.binance.com';
const BYBIT = 'https://api.bybit.eu';
const BYBIT_RECV_WINDOW = '5000';
const BINANCE_CACHE_MS = 120_000;
const BYBIT_CACHE_MS = 30_000;

function configured(v) { return !!v && !/^SET_ME/i.test(v) && !/^CHANGE_ME/i.test(v); }
const binanceConfigured = configured(BINANCE_API_KEY) && configured(BINANCE_API_SECRET);
const bybitConfigured = configured(BYBIT_API_KEY) && configured(BYBIT_API_SECRET);

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ['server-v8.mjs'], {
  cwd: here,
  env: { ...process.env, PORT: String(UPSTREAM_PORT), V6_MCP_INTERNAL_PORT: String(UPSTREAM_PORT + 1) },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (code, signal) => console.error(`v8 upstream exited code=${code} signal=${signal}`));

function json(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache', expires: '0', 'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body), ...extra,
  });
  res.end(body);
}
async function bodyText(req, max = 1_000_000) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > max) throw new Error('request_too_large'); }
  return body;
}
function constantEqual(a, b) {
  const A = Buffer.from(String(a || '')); const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function validMcpPath(p) { return p.startsWith('/mcp/') && constantEqual(p.slice(5), MCP_LINK_TOKEN); }
function hmac(secret, value) { return crypto.createHmac('sha256', secret).update(value).digest('hex'); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForUpstream() {
  let last;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`); if (r.ok) return; last = new Error(`upstream_${r.status}`); }
    catch (e) { last = e; }
    await wait(250);
  }
  throw last || new Error('upstream_timeout');
}

async function upstream(req, res, rawBody) {
  const target = new URL(req.url, `http://127.0.0.1:${UPSTREAM_PORT}`);
  const r = await fetch(target, {
    method: req.method,
    headers: {
      ...(req.headers['content-type'] ? {'content-type': req.headers['content-type']} : {}),
      ...(req.headers.accept ? {accept: req.headers.accept} : {}),
      ...(req.headers['mcp-protocol-version'] ? {'mcp-protocol-version': req.headers['mcp-protocol-version']} : {}),
    },
    body: rawBody,
  });
  const text = await r.text();
  res.writeHead(r.status, {'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8', 'cache-control':'no-store'});
  res.end(text);
}

class ApiError extends Error {
  constructor(exchange, status, code, message, retryable = false) {
    super(`${exchange} ${status}${code !== null ? ` / ${code}` : ''}: ${message}`);
    this.exchange = exchange; this.status = status; this.code = code; this.retryable = retryable;
  }
}

async function binancePublic(pathname) {
  const r = await fetch(`${BINANCE}${pathname}`, {headers:{accept:'application/json','user-agent':'chk-crypto-workspace-v10'}});
  const text = await r.text();
  let root; try { root = JSON.parse(text || '{}'); } catch { root = {}; }
  if (!r.ok) throw new ApiError('Binance', r.status, root?.code ?? null, root?.msg || text.slice(0,180), r.status === 418 || r.status === 429);
  return root;
}
async function binanceSigned(pathname, params = {}) {
  if (!binanceConfigured) throw new Error('Clés Binance Render absentes.');
  const qs = new URLSearchParams();
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null && String(v) !== '') qs.set(k,String(v));
  qs.set('recvWindow','5000'); qs.set('timestamp',String(Date.now()));
  qs.set('signature', hmac(BINANCE_API_SECRET, qs.toString()));
  const r = await fetch(`${BINANCE}${pathname}?${qs}`, {headers:{accept:'application/json','X-MBX-APIKEY':BINANCE_API_KEY,'user-agent':'chk-crypto-workspace-v10'}});
  const text = await r.text(); let root; try { root=JSON.parse(text||'{}'); } catch { root={}; }
  if (!r.ok) throw new ApiError('Binance', r.status, root?.code ?? null, root?.msg || text.slice(0,180), r.status === 418 || r.status === 429);
  return root;
}

function resolvePrice(asset, prices, eurUsd) {
  if (['USDT','USDC','FDUSD','TUSD'].includes(asset)) return 1;
  if (asset === 'EUR') return eurUsd;
  for (const q of ['USDT','USDC']) { const p=prices[`${asset}${q}`]; if (p>0) return p; }
  const btc=prices[`${asset}BTC`], btcUsd=prices.BTCUSDT||prices.BTCUSDC||0;
  return btc>0&&btcUsd>0 ? btc*btcUsd : 0;
}

let binanceCache = {at:0,data:null,lastSuccess:null,lastError:null};
async function loadBinanceLight(force = false) {
  if (!binanceConfigured) throw new Error('Clés Binance non configurées dans Render.');
  if (!force && binanceCache.data && Date.now()-binanceCache.at < BINANCE_CACHE_MS) return {...binanceCache.data, cached:true};
  try {
    const [tickerRows, account] = await Promise.all([
      binancePublic('/api/v3/ticker/price'),
      binanceSigned('/api/v3/account', {omitZeroBalances:'true'}),
    ]);
    const prices={}; for (const row of Array.isArray(tickerRows)?tickerRows:[]) { const p=Number(row?.price||0); if(row?.symbol&&p>0) prices[String(row.symbol).toUpperCase()]=p; }
    const eurUsd=prices.EURUSDT||prices.EURUSDC||1.17;
    const holdings=[]; let totalUsdt=0;
    for (const b of Array.isArray(account?.balances)?account.balances:[]) {
      const asset=String(b?.asset||'').toUpperCase(); const free=Number(b?.free||0); const locked=Number(b?.locked||0); const amount=free+locked;
      if(!asset||!(amount>0)) continue;
      const priceUsdt=resolvePrice(asset,prices,eurUsd); const valueUsdt=amount*priceUsdt; totalUsdt+=valueUsdt;
      holdings.push({asset,amount,free,locked,priceUsdt,valueUsdt});
    }
    holdings.sort((a,b)=>b.valueUsdt-a.valueUsdt);
    const data={capturedAt:Date.now(),totalUsdt,totalEur:eurUsd>0?totalUsdt/eurUsd:totalUsdt,eurUsdt:eurUsd,holdings,source:'render_direct_binance_light'};
    binanceCache={at:Date.now(),data,lastSuccess:new Date().toISOString(),lastError:null};
    return {...data,cached:false};
  } catch (e) {
    binanceCache.lastError={at:new Date().toISOString(),message:String(e.message||e),status:e.status??null,code:e.code??null};
    if (binanceCache.data) return {...binanceCache.data,cached:true,stale:true,liveError:binanceCache.lastError};
    throw e;
  }
}

async function bybitPublic(pathname, params={}) {
  const qs=new URLSearchParams(); for(const[k,v]of Object.entries(params)) if(v!==undefined&&v!==null&&String(v)!=='')qs.set(k,String(v));
  const r=await fetch(`${BYBIT}${pathname}${qs.size?`?${qs}`:''}`,{headers:{accept:'application/json','user-agent':'chk-crypto-workspace-v10'}});
  const text=await r.text(); let root; try{root=JSON.parse(text||'{}');}catch{root={};}
  if(!r.ok||Number(root.retCode||0)!==0) throw new ApiError('Bybit',r.status,root.retCode??null,root.retMsg||text.slice(0,180),r.status>=500);
  return root;
}
async function bybitSigned(method, pathname, paramsOrBody={}) {
  if(!bybitConfigured) throw new Error('Clés Bybit Render absentes.');
  const timestamp=String(Date.now()); let url=`${BYBIT}${pathname}`, payload='', body;
  if(method==='GET'){const qs=new URLSearchParams();for(const[k,v]of Object.entries(paramsOrBody))if(v!==undefined&&v!==null&&String(v)!=='')qs.set(k,String(v));payload=qs.toString();if(payload)url+=`?${payload}`;}
  else {payload=JSON.stringify(paramsOrBody);body=payload;}
  const sig=hmac(BYBIT_API_SECRET,timestamp+BYBIT_API_KEY+BYBIT_RECV_WINDOW+payload);
  const r=await fetch(url,{method,headers:{accept:'application/json','content-type':'application/json','user-agent':'chk-crypto-workspace-v10','X-BAPI-API-KEY':BYBIT_API_KEY,'X-BAPI-TIMESTAMP':timestamp,'X-BAPI-RECV-WINDOW':BYBIT_RECV_WINDOW,'X-BAPI-SIGN':sig},body});
  const text=await r.text();let root;try{root=JSON.parse(text||'{}');}catch{root={};}
  if(!r.ok||Number(root.retCode||0)!==0) throw new ApiError('Bybit',r.status,root.retCode??null,root.retMsg||text.slice(0,220),r.status>=500);
  return root;
}

let bybitCache={at:0,data:null,lastSuccess:null,lastError:null};
async function loadBybitLight(force=false){
  if(!bybitConfigured)throw new Error('Clés Bybit non configurées dans Render.');
  if(!force&&bybitCache.data&&Date.now()-bybitCache.at<BYBIT_CACHE_MS)return{...bybitCache.data,cached:true};
  try{
    const [wallet,tickers,api]=await Promise.all([
      bybitSigned('GET','/v5/account/wallet-balance',{accountType:'UNIFIED'}),
      bybitPublic('/v5/market/tickers',{category:'spot'}),
      bybitSigned('GET','/v5/user/query-api',{}),
    ]);
    const prices={};for(const x of Array.isArray(tickers?.result?.list)?tickers.result.list:[]){const p=Number(x?.lastPrice||0);if(x?.symbol&&p>0)prices[String(x.symbol).toUpperCase()]=p;}
    const account=wallet?.result?.list?.[0]||{};const coins=Array.isArray(account?.coin)?account.coin:[];const holdings=[];
    for(const c of coins){const asset=String(c?.coin||'').toUpperCase();const amount=Number(c?.walletBalance||0);if(!asset||!(amount>0))continue;let valueUsdt=Number(c?.usdValue||0);let priceUsdt=valueUsdt>0?valueUsdt/amount:(prices[`${asset}USDC`]||prices[`${asset}USDT`]||(['USDC','USDT'].includes(asset)?1:0));if(!(valueUsdt>0)&&priceUsdt>0)valueUsdt=amount*priceUsdt;holdings.push({asset,amount,priceUsdt,valueUsdt});}
    holdings.sort((a,b)=>b.valueUsdt-a.valueUsdt);
    const info=api?.result||{};const spot=Array.isArray(info?.permissions?.Spot)?info.permissions.Spot:[];
    const totalUsdt=Number(account?.totalEquity||0)||holdings.reduce((s,h)=>s+h.valueUsdt,0);const eurUsd=prices.EURUSDC||prices.EURUSDT||1.17;
    const data={capturedAt:Date.now(),totalUsdt,totalEur:eurUsd>0?totalUsdt/eurUsd:totalUsdt,holdings,readOnly:Number(info.readOnly)===1,spotPermissions:spot,canSpotTrade:Number(info.readOnly)===0&&spot.includes('SpotTrade'),source:'render_direct_bybit_eu'};
    bybitCache={at:Date.now(),data,lastSuccess:new Date().toISOString(),lastError:null};return{...data,cached:false};
  }catch(e){bybitCache.lastError={at:new Date().toISOString(),message:String(e.message||e),status:e.status??null,code:e.code??null};if(bybitCache.data)return{...bybitCache.data,cached:true,stale:true,liveError:bybitCache.lastError};throw e;}
}

async function directTool(name,args={}){
  if(name==='get_bybit_connection_info'){const b=await loadBybitLight();return{connected:true,source:b.source,readOnly:b.readOnly,spotPermissions:b.spotPermissions,canSpotTrade:b.canSpotTrade,cached:b.cached,stale:b.stale||false,liveError:b.liveError||null};}
  if(name==='get_bybit_portfolio_summary'||name==='list_bybit_assets'){const b=await loadBybitLight();if(name==='list_bybit_assets'){const n=Math.max(1,Math.min(50,Number(args.top_n||20)));return{assets:b.holdings.slice(0,n).map(h=>({coin:h.asset,walletBalance:h.amount,usdValue:h.valueUsdt,priceUsdt:h.priceUsdt})),capturedAt:b.capturedAt,cached:b.cached,stale:b.stale||false};}return{totalEquity:b.totalUsdt,totalEur:b.totalEur,assetCount:b.holdings.length,topAssets:b.holdings.slice(0,8),capturedAt:b.capturedAt,cached:b.cached,stale:b.stale||false,liveError:b.liveError||null};}
  if(name==='list_bybit_open_orders'){const params={category:'spot',limit:Math.max(1,Math.min(50,Number(args.limit||20)))};if(args.symbol)params.symbol=String(args.symbol).toUpperCase().replace(/[^A-Z0-9]/g,'');const root=await bybitSigned('GET','/v5/order/realtime',params);return{orders:Array.isArray(root?.result?.list)?root.result.list:[]};}
  if(name==='list_bybit_recent_executions'){const params={category:'spot',limit:Math.max(1,Math.min(100,Number(args.limit||30)))};if(args.symbol)params.symbol=String(args.symbol).toUpperCase().replace(/[^A-Z0-9]/g,'');const root=await bybitSigned('GET','/v5/execution/list',params);return{executions:Array.isArray(root?.result?.list)?root.result.list:[]};}
  if(name==='list_bybit_usdc_markets'){const root=await bybitPublic('/v5/market/tickers',{category:'spot'});const n=Math.max(1,Math.min(100,Number(args.limit||30)));const markets=(Array.isArray(root?.result?.list)?root.result.list:[]).filter(x=>String(x.symbol||'').endsWith('USDC')&&!String(x.symbol||'').startsWith('USDC')).map(x=>({symbol:x.symbol,lastPrice:Number(x.lastPrice||0),turnover24h:Number(x.turnover24h||0),volume24h:Number(x.volume24h||0),bid1Price:Number(x.bid1Price||0),ask1Price:Number(x.ask1Price||0),price24hPcnt:Number(x.price24hPcnt||0)})).sort((a,b)=>b.turnover24h-a.turnover24h).slice(0,n);return{markets};}
  if(name==='get_portfolio_summary'||name==='list_assets'||name==='get_asset'||name==='get_latest_snapshot'){
    const [bn,bb]=await Promise.allSettled([binanceConfigured?loadBinanceLight():Promise.resolve(null),bybitConfigured?loadBybitLight():Promise.resolve(null)]);
    const b=bn.status==='fulfilled'?bn.value:null;const y=bb.status==='fulfilled'?bb.value:null;const errors={binance:bn.status==='rejected'?String(bn.reason?.message||bn.reason):null,bybit:bb.status==='rejected'?String(bb.reason?.message||bb.reason):null};
    if(name==='get_portfolio_summary')return{workspace:'CHK Crypto Workspace',mode:'CANONICAL_V10',binance:b?{totalEur:b.totalEur,totalUsdt:b.totalUsdt,assetCount:b.holdings.length,topAssets:b.holdings.slice(0,8),cached:b.cached,stale:b.stale||false}:null,bybit:y?{totalEur:y.totalEur,totalUsdt:y.totalUsdt,assetCount:y.holdings.length,topAssets:y.holdings.slice(0,8),cached:y.cached,stale:y.stale||false}:null,errors};
    if(name==='list_assets'){const n=Math.max(1,Math.min(50,Number(args.top_n||20)));return{assets:[...(b?.holdings||[]).slice(0,n).map(a=>({exchange:'BINANCE',...a})),...(y?.holdings||[]).slice(0,n).map(a=>({exchange:'BYBIT',...a}))],errors};}
    if(name==='get_asset'){const s=String(args.symbol||'').toUpperCase();return{symbol:s,binance:b?.holdings.find(a=>a.asset===s)||null,bybit:y?.holdings.find(a=>a.asset===s)||null,errors};}
    return{workspace:'CHK Crypto Workspace',mode:'CANONICAL_V10',capturedAt:new Date().toISOString(),binance:b,bybit:y,errors};
  }
  return null;
}

const DIRECT=new Set(['get_bybit_connection_info','get_bybit_portfolio_summary','list_bybit_assets','list_bybit_open_orders','list_bybit_recent_executions','list_bybit_usdc_markets','get_portfolio_summary','list_assets','get_asset','get_latest_snapshot']);
function rpcResult(id,data,text){return{jsonrpc:'2.0',id,result:{content:[{type:'text',text}],structuredContent:data}};}

async function handleMcp(req,res,rawBody){
  let parsed;try{parsed=JSON.parse(rawBody||'{}');}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
  const run=async msg=>{
    if(msg?.method==='tools/call'){
      const name=String(msg?.params?.name||'');if(DIRECT.has(name)){
        try{const data=await directTool(name,msg?.params?.arguments||{});return rpcResult(msg.id,data,`${name} • route canonique CHK Crypto v10.`);}catch(e){return{jsonrpc:'2.0',id:msg.id,result:{isError:true,content:[{type:'text',text:`Erreur route canonique : ${String(e.message||e).slice(0,350)}`}]}};}
      }
    }
    const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/mcp/${encodeURIComponent(MCP_LINK_TOKEN)}`,{method:'POST',headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18',accept:'application/json'},body:JSON.stringify(msg)});const text=await r.text();if(!r.ok)throw new Error(`upstream_mcp_${r.status}: ${text.slice(0,180)}`);const out=text?JSON.parse(text):null;
    if(msg?.method==='initialize'&&out?.result){out.result.serverInfo={name:'chk-crypto-workspace',version:SERVER_VERSION};out.result.instructions='CHK Crypto canonical v10. Read Binance and Bybit EU directly from Render credentials. Prefer live data; if Binance is rate-limited, clearly mark cached/stale data. Never infer credential errors from legacy services.';}
    return out;
  };
  const out=Array.isArray(parsed)?await Promise.all(parsed.map(run)):await run(parsed);return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});
}

async function health(){
  const result={ok:true,name:'chk-crypto-workspace',version:SERVER_VERSION,canonical:true,credentialSource:'render_environment',binance:{configured:binanceConfigured,lastSuccess:binanceCache.lastSuccess,lastError:binanceCache.lastError,cacheAgeMs:binanceCache.at?Date.now()-binanceCache.at:null},bybit:{configured:bybitConfigured,endpoint:BYBIT,lastSuccess:bybitCache.lastSuccess,lastError:bybitCache.lastError,cacheAgeMs:bybitCache.at?Date.now()-bybitCache.at:null}};
  return result;
}

const server=http.createServer(async(req,res)=>{try{
  const rawBody=req.method==='GET'||req.method==='HEAD'?undefined:await bodyText(req);
  const url=new URL(req.url,`https://${req.headers.host}`);
  if(validMcpPath(url.pathname))return handleMcp(req,res,rawBody);
  if(url.pathname==='/health')return json(res,200,await health());
  if(url.pathname==='/health/live'){
    const checks={};
    try{const b=await loadBinanceLight(true);checks.binance={ok:!b.stale,cached:b.cached,stale:b.stale||false,lastSuccess:binanceCache.lastSuccess,error:b.liveError||null};}catch(e){checks.binance={ok:false,error:String(e.message||e)};}
    try{const y=await loadBybitLight(true);checks.bybit={ok:!y.stale,cached:y.cached,stale:y.stale||false,lastSuccess:bybitCache.lastSuccess,error:y.liveError||null};}catch(e){checks.bybit={ok:false,error:String(e.message||e)};}
    return json(res,200,{...(await health()),checks});
  }
  return upstream(req,res,rawBody);
}catch(e){console.error('v10_request_error',e?.message||e);return json(res,500,{error:'server_error',message:String(e?.message||e).slice(0,300)});}});

try{await waitForUpstream();server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto canonical v${SERVER_VERSION} listening on :${PORT}; upstream v8=${UPSTREAM_PORT}`));}
catch(e){console.error(`v10 startup failed: ${e?.message||e}`);child.kill('SIGTERM');process.exit(1);}
