import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const EDGE_URL = process.env.SUPABASE_EDGE_URL;
const SUPABASE_MCP_TOKEN = process.env.SUPABASE_MCP_TOKEN;
const MCP_LINK_TOKEN = process.env.MCP_LINK_TOKEN;

const REPO = 'Chasmet/APK-Installer-Web-CHK';
const BRANCH = 'binance-portfolio-app';
const BINANCE = 'https://api.binance.com';

for (const [name, value] of Object.entries({ EDGE_URL, SUPABASE_MCP_TOKEN, MCP_LINK_TOKEN })) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function bodyText(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('request_too_large');
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

function alertsEdgeUrl() {
  const u = new URL(EDGE_URL);
  u.pathname = u.pathname.replace(/\/chk-binance-workspace-latest\/?$/, '/chk-binance-alerts');
  return u.toString();
}

async function fetchLatestSnapshot() {
  const r = await fetch(EDGE_URL, {
    method: 'GET',
    headers: {
      'x-chk-token': SUPABASE_MCP_TOKEN,
      accept: 'application/json',
      'user-agent': 'chk-binance-workspace-mcp',
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase edge ${r.status}: ${text.slice(0, 180)}`);
  const data = JSON.parse(text || 'null');
  if (!data?.snapshot) throw new Error('Aucun instantané Binance synchronisé');
  return data;
}

async function alertApi(payload) {
  const r = await fetch(alertsEdgeUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chk-token': SUPABASE_MCP_TOKEN,
      accept: 'application/json',
      'user-agent': 'chk-binance-workspace-mcp',
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text || 'null'); } catch { data = { raw:text }; }
  if (!r.ok) throw new Error(`Alertes ${r.status}: ${data?.error || text.slice(0, 160)}`);
  return data;
}

function portfolioSummary(data) {
  const s = data.snapshot || {};
  const assets = Array.isArray(s.assets) ? s.assets : [];
  const topAssets = [...assets]
    .filter(a => Number(a.valueEur || 0) > 0)
    .sort((a,b) => Number(b.valueEur || 0) - Number(a.valueEur || 0))
    .slice(0,5)
    .map(a => ({ asset:a.asset, amount:a.amount, valueEur:a.valueEur, valueUsdt:a.valueUsdt, priceUsdt:a.priceUsdt }));
  return {
    syncedAt:data.created_at,
    capturedAt:s.capturedAt || null,
    totalEur:s.totalEur ?? null,
    totalUsdt:s.totalUsdt ?? null,
    assetCount:assets.length,
    topAssets,
  };
}

const textExt = new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.json','.html','.css','.scss','.md','.txt','.yml','.yaml','.toml','.gradle','.kts','.xml','.properties','.sh','.py','.java','.kt','.swift','.go','.rs','.sql']);
function isTextPath(path) {
  const lower = path.toLowerCase();
  const i = lower.lastIndexOf('.');
  if (i === -1) return ['readme','license','dockerfile','procfile'].includes(lower.split('/').pop());
  return textExt.has(lower.slice(i));
}

let treeCache = { at:0, items:[] };
async function githubTree() {
  if (Date.now() - treeCache.at < 60_000 && treeCache.items.length) return treeCache.items;
  const url = `https://api.github.com/repos/${REPO}/git/trees/${encodeURIComponent(BRANCH)}?recursive=1`;
  const r = await fetch(url, { headers:{accept:'application/vnd.github+json','user-agent':'chk-binance-workspace-mcp'} });
  if (!r.ok) throw new Error(`GitHub tree ${r.status}`);
  const data = await r.json();
  const items = Array.isArray(data.tree)
    ? data.tree.filter(x => x.type === 'blob').map(x => ({path:x.path,size:x.size || 0,sha:x.sha}))
    : [];
  treeCache = { at:Date.now(), items };
  return items;
}

async function githubFile(path) {
  const tree = await githubTree();
  const item = tree.find(x => x.path === path);
  if (!item) throw new Error('Fichier introuvable dans le projet');
  if (!isTextPath(path)) throw new Error('Fichier non textuel');
  if (item.size > 250_000) throw new Error('Fichier trop volumineux');
  const raw = `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(BRANCH)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(raw, { headers:{'user-agent':'chk-binance-workspace-mcp'} });
  if (!r.ok) throw new Error(`GitHub raw ${r.status}`);
  return await r.text();
}

async function searchRepo(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const tree = await githubTree();
  const words = q.split(/\s+/).filter(Boolean);
  const scored = tree.filter(x => isTextPath(x.path)).map(x => {
    const p = x.path.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (p.includes(w)) score += 8;
      if (p.split('/').pop()?.includes(w)) score += 4;
    }
    return {...x,score};
  }).filter(x => x.score > 0).sort((a,b) => b.score - a.score).slice(0,12);

  if (scored.length >= 5) {
    return scored.map(x => ({ id:x.path, title:x.path, text:`Fichier du projet CHK Binance (${x.size} octets).` }));
  }

  const fallback = tree.filter(x => isTextPath(x.path) && x.size > 0 && x.size < 80_000).slice(0,24);
  const found = [...scored];
  const seen = new Set(found.map(x => x.path));
  for (const item of fallback) {
    if (found.length >= 10) break;
    if (seen.has(item.path)) continue;
    try {
      const text = (await githubFile(item.path)).toLowerCase();
      if (words.every(w => text.includes(w))) {
        found.push({...item,score:1});
        seen.add(item.path);
      }
    } catch {}
  }
  return found.slice(0,10).map(x => ({ id:x.path, title:x.path, text:`Correspondance dans le projet CHK Binance (${x.size} octets).` }));
}

async function binanceJson(path) {
  const r = await fetch(`${BINANCE}${path}`, { headers:{accept:'application/json','user-agent':'chk-binance-workspace-mcp'} });
  const text = await r.text();
  if (!r.ok) throw new Error(`Binance ${r.status}: ${text.slice(0,160)}`);
  return JSON.parse(text);
}

function cleanSymbol(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,20);
}

function sma(values, period) {
  if (values.length < period) return null;
  const a = values.slice(-period);
  return a.reduce((s,v)=>s+v,0) / a.length;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  const diffs = [];
  for (let i = values.length - period; i < values.length; i++) diffs.push(values[i] - values[i-1]);
  let gains = 0, losses = 0;
  for (const d of diffs) { if (d > 0) gains += d; else losses -= d; }
  if (losses === 0) return 100;
  const rs = (gains/period) / (losses/period);
  return 100 - (100/(1+rs));
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const cur = candles[i], prev = candles[i-1];
    trs.push(Math.max(cur.high-cur.low, Math.abs(cur.high-prev.close), Math.abs(cur.low-prev.close)));
  }
  return trs.reduce((s,v)=>s+v,0)/trs.length;
}

function roundedPrice(v) {
  if (!Number.isFinite(v) || v <= 0) return null;
  if (v >= 1000) return Number(v.toFixed(0));
  if (v >= 100) return Number(v.toFixed(1));
  if (v >= 10) return Number(v.toFixed(2));
  if (v >= 1) return Number(v.toFixed(3));
  if (v >= 0.01) return Number(v.toFixed(5));
  return Number(v.toPrecision(5));
}

async function analyzeCrypto(symbolValue) {
  const symbol = cleanSymbol(symbolValue);
  if (!symbol) throw new Error('Symbole crypto invalide');
  if (['USDT','USDC','FDUSD','TUSD','EUR'].includes(symbol)) {
    return {symbol, pair:null, stableAsset:true, note:'Actif stable/fiat : pas de niveaux techniques automatiques proposés.'};
  }
  const pair = `${symbol}USDT`;
  const [ticker, rawKlines] = await Promise.all([
    binanceJson(`/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`),
    binanceJson(`/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=4h&limit=60`),
  ]);
  const candles = rawKlines.map(k => ({open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),volume:Number(k[5])}));
  const closes = candles.map(c=>c.close).filter(Number.isFinite);
  const highs = candles.map(c=>c.high).filter(Number.isFinite);
  const lows = candles.map(c=>c.low).filter(Number.isFinite);
  const current = Number(ticker.lastPrice || closes.at(-1));
  const sma20 = sma(closes,20), sma50 = sma(closes,50), rsi14 = rsi(closes,14), atr14 = atr(candles,14);
  const recent = candles.slice(-18);
  const support3d = Math.min(...recent.map(c=>c.low));
  const resistance3d = Math.max(...recent.map(c=>c.high));
  const support10d = Math.min(...lows);
  const resistance10d = Math.max(...highs);
  let trend = 'neutre';
  if (sma20 && sma50) {
    if (sma20 > sma50 * 1.015) trend = 'haussière';
    else if (sma20 < sma50 * 0.985) trend = 'baissière';
  }
  const vol = atr14 || current * 0.04;
  const aboveResistance = resistance3d > current * 1.01 ? resistance3d : current + Math.max(vol*1.2,current*0.05);
  const upside = current + Math.max(vol*2.2,current*0.10);
  const downside = Math.max(current - Math.max(vol*1.5,current*0.07), current*0.1);
  const suggestions = [
    {kind:'resistance',condition:'above',targetPrice:roundedPrice(aboveResistance),label:`${symbol} franchit une zone haute`,rationale:'Surveillance d’un franchissement de résistance récente. Vérifier volume et contexte avant toute décision.'},
    {kind:'profit_watch',condition:'above',targetPrice:roundedPrice(upside),label:`${symbol} hausse marquée`,rationale:'Alerte de hausse supplémentaire basée sur la volatilité récente, utile pour réexaminer une prise de bénéfices.'},
    {kind:'risk_watch',condition:'below',targetPrice:roundedPrice(downside),label:`${symbol} baisse à surveiller`,rationale:'Alerte de protection basée sur la volatilité récente, utile pour réexaminer le risque.'},
  ];
  return {
    symbol,pair,currentPrice:current,
    change24hPercent:Number(ticker.priceChangePercent),
    high24h:Number(ticker.highPrice),low24h:Number(ticker.lowPrice),
    volume24h:Number(ticker.volume),quoteVolume24h:Number(ticker.quoteVolume),
    sma20:sma20==null?null:roundedPrice(sma20),
    sma50:sma50==null?null:roundedPrice(sma50),
    rsi14:rsi14==null?null:Number(rsi14.toFixed(1)),
    atr14:atr14==null?null:roundedPrice(atr14),
    support3d:roundedPrice(support3d),resistance3d:roundedPrice(resistance3d),
    support10d:roundedPrice(support10d),resistance10d:roundedPrice(resistance10d),
    trend,
    suggestions,
    disclaimer:'Analyse technique de surveillance, pas un ordre d’achat ou de vente.'
  };
}

const readAnnotations = { readOnlyHint:true, destructiveHint:false, openWorldHint:true, idempotentHint:true };
const projectReadAnnotations = { readOnlyHint:true, destructiveHint:false, openWorldHint:false, idempotentHint:true };
const createAnnotations = { readOnlyHint:false, destructiveHint:false, openWorldHint:true, idempotentHint:false };
const updateAnnotations = { readOnlyHint:false, destructiveHint:false, openWorldHint:false, idempotentHint:true };
const deleteAnnotations = { readOnlyHint:false, destructiveHint:true, openWorldHint:false, idempotentHint:true };

const tools = [
  {name:'search',title:'Rechercher dans le projet CHK Binance',description:'Use this when the user asks about the CHK Binance Android app, APK, MCP, deployment, source code, configuration, or a project file. Search the fixed CHK Binance repository branch and return matching file identifiers.',inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:200}},required:['query'],additionalProperties:false},annotations:projectReadAnnotations},
  {name:'fetch',title:'Lire un fichier du projet CHK Binance',description:'Use this after search when the user needs the contents of a specific CHK Binance project file. The id must be a path returned by search.',inputSchema:{type:'object',properties:{id:{type:'string',minLength:1,maxLength:400}},required:['id'],additionalProperties:false},annotations:projectReadAnnotations},
  {name:'get_workspace_info',title:'État de l’espace CHK Binance',description:'Use this when the user asks whether the persistent CHK Binance MCP is online or how the APK, Supabase, GitHub, Render and ChatGPT are connected.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:projectReadAnnotations},
  {name:'get_portfolio_summary',title:'Résumé du portefeuille Binance',description:'Use this when the user asks for the latest synchronized Binance portfolio total or largest holdings.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:projectReadAnnotations},
  {name:'list_assets',title:'Lister les cryptos du portefeuille',description:'Use this when the user asks which crypto assets are held, their quantities, or their EUR/USDT values.',inputSchema:{type:'object',properties:{top_n:{type:'integer',minimum:1,maximum:50,default:20}},additionalProperties:false},annotations:projectReadAnnotations},
  {name:'get_asset',title:'Consulter une crypto',description:'Use this when the user asks about one specific crypto asset held in the synchronized Binance portfolio.',inputSchema:{type:'object',properties:{symbol:{type:'string',minLength:1,maxLength:20}},required:['symbol'],additionalProperties:false},annotations:projectReadAnnotations},
  {name:'get_latest_snapshot',title:'Lire le dernier instantané complet',description:'Use this when detailed analysis requires the full latest Binance portfolio snapshot synchronized by the Android APK.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:projectReadAnnotations},
  {name:'analyze_crypto',title:'Analyser une crypto et proposer des niveaux d’alerte',description:'Use this when the user asks for analysis of one crypto or wants objective price levels to monitor. Returns Binance market data, RSI, moving averages, volatility, support/resistance and suggested alert levels.',inputSchema:{type:'object',properties:{symbol:{type:'string',minLength:1,maxLength:20}},required:['symbol'],additionalProperties:false},annotations:readAnnotations},
  {name:'suggest_portfolio_alerts',title:'Proposer des alertes pour le portefeuille',description:'Use this when the user wants alert suggestions for the largest non-stable assets currently held. Does not create alerts.',inputSchema:{type:'object',properties:{top_n:{type:'integer',minimum:1,maximum:5,default:3}},additionalProperties:false},annotations:readAnnotations},
  {name:'list_price_alerts',title:'Lister les alertes de prix',description:'Use this when the user asks which crypto alarms are currently configured by ChatGPT or the Android app.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:projectReadAnnotations},
  {name:'create_price_alert',title:'Créer une alerte de prix',description:'Use this when the user asks to create or set a crypto price alarm. This stores the alarm for the CHK Binance Android app, which will notify when the threshold is reached.',inputSchema:{type:'object',properties:{symbol:{type:'string',minLength:1,maxLength:20},condition:{type:'string',enum:['above','below']},target_price:{type:'number',exclusiveMinimum:0},label:{type:'string',maxLength:120},rationale:{type:'string',maxLength:700}},required:['symbol','condition','target_price'],additionalProperties:false},annotations:createAnnotations},
  {name:'create_suggested_alerts',title:'Créer automatiquement les alertes suggérées',description:'Use this only when the user explicitly asks ChatGPT to set recommended alarms. Analyzes the largest holdings and creates up to three surveillance alerts per asset.',inputSchema:{type:'object',properties:{top_n:{type:'integer',minimum:1,maximum:3,default:3}},additionalProperties:false},annotations:createAnnotations},
  {name:'set_price_alert_enabled',title:'Activer ou désactiver une alerte',description:'Use this when the user asks to enable or disable an existing price alarm by id.',inputSchema:{type:'object',properties:{id:{type:'string',minLength:36,maxLength:36},enabled:{type:'boolean'}},required:['id','enabled'],additionalProperties:false},annotations:updateAnnotations},
  {name:'delete_price_alert',title:'Supprimer une alerte de prix',description:'Use this when the user explicitly asks to permanently delete a configured price alarm by id.',inputSchema:{type:'object',properties:{id:{type:'string',minLength:36,maxLength:36}},required:['id'],additionalProperties:false},annotations:deleteAnnotations},
];

async function callTool(name, args = {}) {
  if (name === 'search') {
    const results = await searchRepo(args.query);
    return {content:[{type:'text',text:`${results.length} résultat(s) dans le projet CHK Binance.`}],structuredContent:{results}};
  }
  if (name === 'fetch') {
    const id = String(args.id || '').trim();
    const text = await githubFile(id);
    return {content:[{type:'text',text:`Fichier ${id} lu depuis le projet CHK Binance.`}],structuredContent:{id,title:id,text,url:`https://github.com/${REPO}/blob/${BRANCH}/${id}`}};
  }
  if (name === 'get_workspace_info') {
    let latestSync = null, alerts = [];
    try { latestSync = portfolioSummary(await fetchLatestSnapshot()); } catch {}
    try { alerts = (await alertApi({action:'list'})).alerts || []; } catch {}
    return {content:[{type:'text',text:'Espace CHK Binance persistant disponible avec analyse et alertes.'}],structuredContent:{repository:REPO,branch:BRANCH,mcpMode:'secret-url-no-oauth',readOnly:false,latestSync,activeAlertCount:alerts.filter(a=>a.enabled).length,capabilities:['project search','project file read','Binance synchronized portfolio read','crypto technical analysis','persistent price alerts'],note:'Le MCP ne possède aucun outil de trading, transfert ou retrait. Les alertes servent à prévenir et réexaminer une décision.'}};
  }
  if (name === 'analyze_crypto') {
    const analysis = await analyzeCrypto(args.symbol);
    return {content:[{type:'text',text:`Analyse technique de surveillance ${analysis.symbol}.`}],structuredContent:analysis};
  }
  if (name === 'list_price_alerts') {
    const data = await alertApi({action:'list'});
    return {content:[{type:'text',text:`${(data.alerts || []).length} alerte(s) configurée(s).`}],structuredContent:data};
  }
  if (name === 'create_price_alert') {
    const symbol = cleanSymbol(args.symbol);
    const data = await alertApi({action:'create',symbol,pair:`${symbol}USDT`,condition:args.condition,targetPrice:Number(args.target_price),label:args.label || `${symbol} • alerte prix`,rationale:args.rationale || 'Alerte créée à la demande de l’utilisateur.',source:'chatgpt',oneShot:true});
    return {content:[{type:'text',text:`Alerte ${symbol} créée dans CHK Binance.`}],structuredContent:data};
  }
  if (name === 'set_price_alert_enabled') {
    const data = await alertApi({action:'set_enabled',id:args.id,enabled:args.enabled === true});
    return {content:[{type:'text',text:`Alerte ${args.enabled ? 'activée' : 'désactivée'}.`}],structuredContent:data};
  }
  if (name === 'delete_price_alert') {
    const data = await alertApi({action:'delete',id:args.id});
    return {content:[{type:'text',text:'Alerte supprimée.'}],structuredContent:data};
  }

  const data = await fetchLatestSnapshot();
  const s = data.snapshot || {};
  const assets = Array.isArray(s.assets) ? [...s.assets] : [];
  assets.sort((a,b) => Number(b.valueEur || 0) - Number(a.valueEur || 0));

  if (name === 'get_portfolio_summary') return {content:[{type:'text',text:'Résumé du dernier portefeuille Binance synchronisé.'}],structuredContent:portfolioSummary(data)};
  if (name === 'list_assets') {
    const n = Math.max(1,Math.min(50,Number(args.top_n || 20)));
    return {content:[{type:'text',text:`${Math.min(n,assets.length)} actifs du dernier instantané.`}],structuredContent:{syncedAt:data.created_at,totalEur:s.totalEur,totalUsdt:s.totalUsdt,assets:assets.slice(0,n)}};
  }
  if (name === 'get_asset') {
    const symbol = cleanSymbol(args.symbol);
    const asset = assets.find(a => String(a.asset).toUpperCase() === symbol) || null;
    return {content:[{type:'text',text:asset?`${symbol} est présent.`:`${symbol} n’apparaît pas dans le dernier instantané.`}],structuredContent:{syncedAt:data.created_at,found:!!asset,asset}};
  }
  if (name === 'get_latest_snapshot') return {content:[{type:'text',text:'Dernier instantané complet du portefeuille.'}],structuredContent:{syncedAt:data.created_at,snapshot:s}};

  if (name === 'suggest_portfolio_alerts' || name === 'create_suggested_alerts') {
    const n = Math.max(1,Math.min(name === 'create_suggested_alerts' ? 3 : 5,Number(args.top_n || 3)));
    const held = assets.filter(a => Number(a.valueEur || 0) >= 1 && !['USDT','USDC','FDUSD','TUSD','EUR'].includes(String(a.asset).toUpperCase())).slice(0,n);
    const analyses = [];
    for (const a of held) {
      try { analyses.push(await analyzeCrypto(a.asset)); } catch (error) { analyses.push({symbol:a.asset,error:String(error.message || error)}); }
    }
    if (name === 'suggest_portfolio_alerts') {
      return {content:[{type:'text',text:`Suggestions calculées pour ${analyses.filter(a=>!a.error).length} actif(s) principaux.`}],structuredContent:{generatedAt:new Date().toISOString(),analyses}};
    }

    const existing = (await alertApi({action:'list'})).alerts || [];
    const created = [], skipped = [];
    for (const analysis of analyses) {
      if (analysis.error || !Array.isArray(analysis.suggestions)) continue;
      for (const suggestion of analysis.suggestions) {
        const target = Number(suggestion.targetPrice);
        const duplicate = existing.find(e => e.enabled && e.pair === analysis.pair && e.condition === suggestion.condition && Math.abs(Number(e.target_price)-target)/target < 0.006);
        if (duplicate) { skipped.push({symbol:analysis.symbol,targetPrice:target,reason:'alerte proche déjà active'}); continue; }
        const result = await alertApi({action:'create',symbol:analysis.symbol,pair:analysis.pair,condition:suggestion.condition,targetPrice:target,label:suggestion.label,rationale:suggestion.rationale,source:'chatgpt-auto',oneShot:true});
        if (result?.alert) { created.push(result.alert); existing.push(result.alert); }
      }
    }
    return {content:[{type:'text',text:`${created.length} alerte(s) de surveillance créée(s) dans CHK Binance.`}],structuredContent:{created,skipped,analyses}};
  }

  throw new Error(`Outil inconnu: ${name}`);
}

async function rpc(message) {
  if (!message || message.jsonrpc !== '2.0') return {jsonrpc:'2.0',id:message?.id ?? null,error:{code:-32600,message:'Invalid Request'}};
  if (message.method === 'initialize') return {jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params?.protocolVersion || '2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'chk-binance-workspace',version:'3.0.0'},instructions:'Persistent CHK Binance workspace. It can read the project and synchronized portfolio, analyze public Binance market data, and create persistent price alerts for the Android app. It has no buy, sell, trading, transfer or withdrawal tools.'}};
  if (message.method === 'ping') return {jsonrpc:'2.0',id:message.id,result:{}};
  if (message.method === 'tools/list') return {jsonrpc:'2.0',id:message.id,result:{tools}};
  if (message.method === 'tools/call') {
    try { return {jsonrpc:'2.0',id:message.id,result:await callTool(message.params?.name,message.params?.arguments || {})}; }
    catch (error) { return {jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:`Erreur MCP CHK Binance : ${String(error.message || error).slice(0,250)}`}]}}; }
  }
  if (message.id == null) return null;
  return {jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Method not found'}};
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, {'allow':'POST','cache-control':'no-store'});
    return res.end('Use POST for MCP.');
  }
  let parsed;
  try { parsed = JSON.parse(await bodyText(req)); }
  catch { return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}); }

  if (Array.isArray(parsed)) {
    const out = (await Promise.all(parsed.map(rpc))).filter(Boolean);
    if (!out.length) { res.writeHead(202, {'cache-control':'no-store'}); return res.end(); }
    return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});
  }
  const out = await rpc(parsed);
  if (!out) { res.writeHead(202, {'cache-control':'no-store'}); return res.end(); }
  return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});
}

const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    if (url.pathname === '/health') return json(res,200,{ok:true,name:'chk-binance-workspace',version:'3.0.0',readOnly:false,auth:'secret-url',features:['portfolio','analysis','alerts']});
    if (validMcpPath(url.pathname)) return handleMcp(req,res);
    if (url.pathname === '/') return json(res,200,{name:'CHK Binance Workspace MCP',version:'3.0.0',readOnly:false,status:'online',features:['portfolio','analysis','alerts']});
    return json(res,404,{error:'not_found'});
  } catch (error) {
    console.error('request_error', error?.message || error);
    return json(res,500,{error:'server_error'});
  }
});

server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Binance Workspace MCP v3.0 listening on :${PORT}`));
