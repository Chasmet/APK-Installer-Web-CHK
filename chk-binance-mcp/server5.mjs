import http from 'node:http';
import crypto from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MCP_READ_TOKEN = process.env.MCP_READ_TOKEN;
const MCP_TOKEN_SECRET = process.env.MCP_TOKEN_SECRET;
const MCP_LOGIN_PIN = process.env.MCP_LOGIN_PIN;

const REPO = 'Chasmet/APK-Installer-Web-CHK';
const BRANCH = 'binance-portfolio-app';
const RENDER_URL = 'https://chk-binance-mcp.onrender.com';

for (const [name, value] of Object.entries({
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  MCP_READ_TOKEN,
  MCP_TOKEN_SECRET,
  MCP_LOGIN_PIN,
})) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, '');
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

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function bodyText(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('request_too_large');
  }
  return body;
}

async function parseBody(req) {
  const raw = await bodyText(req);
  const ct = String(req.headers['content-type'] || '');
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function constantEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function accessToken() {
  return crypto.createHmac('sha256', MCP_TOKEN_SECRET)
    .update(`chk-binance-mcp-link:${MCP_LOGIN_PIN}`)
    .digest('base64url');
}

function secretMcpUrl(base) {
  return `${base}/mcp/${accessToken()}`;
}

function validSecretPath(pathname) {
  const prefix = '/mcp/';
  if (!pathname.startsWith(prefix)) return false;
  const token = pathname.slice(prefix.length);
  return constantEqual(token, accessToken());
}

function pairForm(error = '') {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CHK Binance MCP</title><style>
  body{margin:0;background:#0b0e11;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(520px,calc(100% - 32px));background:#181a20;border:1px solid #2b3139;border-radius:22px;padding:24px;box-sizing:border-box}.gold{color:#f0b90b}.muted{color:#929aa6;line-height:1.5}label{display:block;margin:22px 0 8px;font-weight:700}input{width:100%;box-sizing:border-box;padding:14px;border:2px solid #fff;border-radius:12px;background:#0b0e11;color:#fff;font-size:18px}button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#f0b90b;color:#111;font-weight:800;font-size:16px}.err{color:#ff6670}</style></head><body><main class="card"><h1><span class="gold">CHK</span> Binance MCP</h1><p class="muted">Crée un lien MCP privé persistant sans OAuth. Ce lien servira ensuite dans ChatGPT avec l’authentification réglée sur « Aucune ».</p>${error ? `<p class="err">${esc(error)}</p>` : ''}<form method="post" action="/pair"><label>Code privé MCP</label><input name="pin" type="password" inputmode="numeric" required autofocus><button type="submit">Créer mon lien MCP privé</button></form><p class="muted">Ne partage pas le lien généré : il donne accès en lecture seule à ton espace CHK Binance.</p></main></body></html>`;
}

function pairResult(url) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CHK Binance MCP prêt</title><style>
  body{margin:0;background:#0b0e11;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(620px,calc(100% - 32px));background:#181a20;border:1px solid #2b3139;border-radius:22px;padding:24px;box-sizing:border-box}.gold{color:#f0b90b}.muted{color:#929aa6;line-height:1.5}.box{word-break:break-all;background:#0b0e11;border:1px solid #3a4049;border-radius:12px;padding:14px;margin:16px 0;font-family:ui-monospace,monospace}.ok{color:#35c28a}</style></head><body><main class="card"><h1><span class="gold">CHK</span> Binance MCP</h1><p class="ok"><strong>Lien privé créé.</strong></p><p class="muted">Dans ChatGPT, crée une app MCP avec <strong>Authentification : Aucune</strong> et colle exactement cette URL :</p><div class="box">${esc(url)}</div><p class="muted">Ce lien reste valable tant que ton code MCP ou le secret serveur ne change pas. Il fonctionne dans les nouvelles conversations une fois l’app ajoutée à ChatGPT.</p></main></body></html>`;
}

async function fetchLatestSnapshot() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/chk_binance_mcp_latest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ p_token: MCP_READ_TOKEN }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 180)}`);
  let data = JSON.parse(text || 'null');
  if (Array.isArray(data) && data.length === 1) data = data[0];
  if (!data?.snapshot) throw new Error('Aucun instantané Binance synchronisé');
  return data;
}

function portfolioSummary(data) {
  const s = data.snapshot || {};
  const assets = Array.isArray(s.assets) ? s.assets : [];
  const topAssets = [...assets]
    .filter(a => Number(a.valueEur || 0) > 0)
    .sort((a,b) => Number(b.valueEur || 0) - Number(a.valueEur || 0))
    .slice(0,5)
    .map(a => ({asset:a.asset,amount:a.amount,valueEur:a.valueEur,valueUsdt:a.valueUsdt}));
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
  const r = await fetch(url, { headers:{'accept':'application/vnd.github+json','user-agent':'chk-binance-mcp'} });
  if (!r.ok) throw new Error(`GitHub tree ${r.status}`);
  const data = await r.json();
  const items = Array.isArray(data.tree) ? data.tree.filter(x => x.type === 'blob').map(x => ({path:x.path,size:x.size||0,sha:x.sha})) : [];
  treeCache = { at:Date.now(), items };
  return items;
}

async function githubFile(path) {
  const tree = await githubTree();
  const item = tree.find(x => x.path === path);
  if (!item) throw new Error('Fichier introuvable dans le projet');
  if (!isTextPath(path)) throw new Error('Ce fichier n’est pas un fichier texte lisible par le MCP');
  if (item.size > 250_000) throw new Error('Fichier trop volumineux pour une lecture MCP');
  const raw = `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(BRANCH)}/${path.split('/').map(encodeURIComponent).join('/')}`;
  const r = await fetch(raw, { headers:{'user-agent':'chk-binance-mcp'} });
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

  if (scored.length >= 5) return scored.map(x => ({id:x.path,title:x.path,text:`Fichier du projet CHK Binance (${x.size} octets).`}));

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
  return found.slice(0,10).map(x => ({id:x.path,title:x.path,text:`Correspondance dans le projet CHK Binance (${x.size} octets).`}));
}

const annotations = {readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true};
const tools = [
  {
    name:'search',
    title:'Rechercher dans le projet CHK Binance',
    description:'Use this when the user asks about the CHK Binance Android app, its MCP, deployment, source code, configuration, or a file in the project. Search the fixed CHK Binance repository branch and return matching file identifiers.',
    inputSchema:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:200}},required:['query'],additionalProperties:false},
    annotations,
  },
  {
    name:'fetch',
    title:'Lire un fichier du projet CHK Binance',
    description:'Use this after search when the user needs the contents of a specific CHK Binance project file. The id must be a path returned by search.',
    inputSchema:{type:'object',properties:{id:{type:'string',minLength:1,maxLength:400}},required:['id'],additionalProperties:false},
    annotations,
  },
  {
    name:'get_workspace_info',
    title:'État de l’espace CHK Binance',
    description:'Use this when the user asks whether the persistent CHK Binance MCP is online, which repository/branch it uses, or how the APK, Supabase, Render and ChatGPT are connected.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},
    annotations,
  },
  {
    name:'get_portfolio_summary',
    title:'Résumé du portefeuille Binance',
    description:'Use this when the user asks for the latest synchronized Binance portfolio total or largest holdings.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},
    annotations,
  },
  {
    name:'list_assets',
    title:'Lister les cryptos du portefeuille',
    description:'Use this when the user asks which crypto assets are held, their quantities, or their EUR/USDT values.',
    inputSchema:{type:'object',properties:{top_n:{type:'integer',minimum:1,maximum:50,default:20}},additionalProperties:false},
    annotations,
  },
  {
    name:'get_asset',
    title:'Consulter une crypto',
    description:'Use this when the user asks about one specific crypto asset held in the synchronized Binance portfolio.',
    inputSchema:{type:'object',properties:{symbol:{type:'string',minLength:1,maxLength:20}},required:['symbol'],additionalProperties:false},
    annotations,
  },
  {
    name:'get_latest_snapshot',
    title:'Lire le dernier instantané complet',
    description:'Use this when detailed analysis requires the full latest Binance portfolio snapshot synchronized by the Android APK.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},
    annotations,
  },
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
    let sync = null;
    try { sync = portfolioSummary(await fetchLatestSnapshot()); } catch {}
    return {content:[{type:'text',text:'Espace CHK Binance persistant en lecture seule.'}],structuredContent:{
      repository:REPO,
      branch:BRANCH,
      render:RENDER_URL,
      mcpMode:'secret-url-no-oauth',
      readOnly:true,
      latestSync:sync,
      note:'Le MCP conserve le contexte projet et Binance entre les conversations. Les modifications de code restent à effectuer via le connecteur GitHub ChatGPT lorsque disponible.'
    }};
  }

  const data = await fetchLatestSnapshot();
  const s = data.snapshot || {};
  const assets = Array.isArray(s.assets) ? [...s.assets] : [];
  assets.sort((a,b) => Number(b.valueEur || 0) - Number(a.valueEur || 0));

  if (name === 'get_portfolio_summary') {
    const summary = portfolioSummary(data);
    return {content:[{type:'text',text:'Résumé du dernier portefeuille Binance synchronisé.'}],structuredContent:summary};
  }
  if (name === 'list_assets') {
    const n = Math.max(1,Math.min(50,Number(args.top_n || 20)));
    return {content:[{type:'text',text:`${Math.min(n,assets.length)} actifs du dernier instantané.`}],structuredContent:{syncedAt:data.created_at,totalEur:s.totalEur,totalUsdt:s.totalUsdt,assets:assets.slice(0,n)}};
  }
  if (name === 'get_asset') {
    const symbol = String(args.symbol || '').trim().toUpperCase();
    const asset = assets.find(a => String(a.asset).toUpperCase() === symbol) || null;
    return {content:[{type:'text',text:asset?`${symbol} est présent.`:`${symbol} n’apparaît pas dans le dernier instantané.`}],structuredContent:{syncedAt:data.created_at,found:!!asset,asset}};
  }
  if (name === 'get_latest_snapshot') {
    return {content:[{type:'text',text:'Dernier instantané complet du portefeuille.'}],structuredContent:{syncedAt:data.created_at,snapshot:s}};
  }
  throw new Error(`Outil inconnu: ${name}`);
}

async function rpc(message) {
  if (!message || message.jsonrpc !== '2.0') return {jsonrpc:'2.0',id:message?.id ?? null,error:{code:-32600,message:'Invalid Request'}};
  if (message.method === 'initialize') return {jsonrpc:'2.0',id:message.id,result:{protocolVersion:message.params?.protocolVersion || '2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'chk-binance-workspace',version:'2.0.0'},instructions:'Persistent read-only CHK Binance workspace: project search/fetch plus APK-synchronized Binance portfolio data. No buy, sell, transfer or withdrawal tools exist.'}};
  if (message.method === 'ping') return {jsonrpc:'2.0',id:message.id,result:{}};
  if (message.method === 'tools/list') return {jsonrpc:'2.0',id:message.id,result:{tools}};
  if (message.method === 'tools/call') {
    try { return {jsonrpc:'2.0',id:message.id,result:await callTool(message.params?.name,message.params?.arguments || {})}; }
    catch (error) { return {jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:`Erreur MCP CHK Binance : ${String(error.message || error).slice(0,250)}`} ]}}; }
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
    const base = baseUrl(req);
    const url = new URL(req.url, base);

    if (url.pathname === '/health') return json(res,200,{ok:true,name:'chk-binance-workspace',version:'2.0.0',readOnly:true,auth:'secret-url'});

    if (url.pathname === '/pair') {
      if (req.method === 'GET') return html(res,200,pairForm());
      if (req.method === 'POST') {
        const p = await parseBody(req);
        if (!constantEqual(p.pin,MCP_LOGIN_PIN)) return html(res,401,pairForm('Code privé incorrect.'));
        return html(res,200,pairResult(secretMcpUrl(base)));
      }
      res.writeHead(405, {'allow':'GET, POST'}); return res.end();
    }

    if (validSecretPath(url.pathname)) return handleMcp(req,res);

    if (url.pathname === '/') return html(res,200,`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CHK Binance Workspace</title></head><body style="background:#0b0e11;color:white;font-family:system-ui;padding:32px"><h1>CHK Binance Workspace MCP</h1><p>MCP privé persistant en lecture seule.</p><p>Pour créer ton lien privé : <strong>/pair</strong></p><p>Version 2.0.0</p></body></html>`);

    return json(res,404,{error:'not_found'});
  } catch (error) {
    console.error('request_error', error?.message || error);
    return json(res,500,{error:'server_error'});
  }
});

server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Binance Workspace MCP v2.0 listening on :${PORT}`));
