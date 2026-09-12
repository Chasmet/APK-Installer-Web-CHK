import http from "node:http";
import crypto from "node:crypto";
import { URL, URLSearchParams } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MCP_READ_TOKEN = process.env.MCP_READ_TOKEN;
const MCP_TOKEN_SECRET = process.env.MCP_TOKEN_SECRET;
const MCP_LOGIN_PIN = process.env.MCP_LOGIN_PIN;
const SCOPE = "portfolio:read";
const OFFLINE_SCOPE = "offline_access";

for (const [name, value] of Object.entries({SUPABASE_URL,SUPABASE_ANON_KEY,MCP_READ_TOKEN,MCP_TOKEN_SECRET,MCP_LOGIN_PIN})) {
  if (!value) { console.error(`Missing required environment variable: ${name}`); process.exit(1); }
}

const authCodes = new Map();

function baseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, "");
}
function resourceUrl(base) { return `${base}/mcp`; }
function protectedMetadataUrl(base) { return `${base}/.well-known/oauth-protected-resource/mcp`; }
function normalizeResource(value, base) {
  if (!value || value === base || value === `${base}/`) return resourceUrl(base);
  if (value === resourceUrl(base) || value === `${resourceUrl(base)}/`) return resourceUrl(base);
  return null;
}
function json(res,status,data,headers={}) {
  const body = JSON.stringify(data);
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-length":Buffer.byteLength(body),...headers});
  res.end(body);
}
function html(res,status,body) {
  res.writeHead(status,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
  res.end(body);
}
async function bodyText(req) { let b=""; for await (const c of req) { b += c; if (b.length > 1_000_000) throw new Error("request_too_large"); } return b; }
async function parseBody(req) {
  const raw = await bodyText(req); const ct = String(req.headers["content-type"] || "");
  if (ct.includes("application/json")) { try { return JSON.parse(raw || "{}"); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}
function esc(v="") { return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function b64(v) { return Buffer.from(v).toString("base64url"); }
function randomId(n=24) { return crypto.randomBytes(n).toString("base64url"); }
function sha256(v) { return crypto.createHash("sha256").update(v).digest("base64url"); }
function constantEqual(a,b) { const A=Buffer.from(String(a||"")), B=Buffer.from(String(b||"")); return A.length===B.length && crypto.timingSafeEqual(A,B); }
function sign(payload) { const body=b64(JSON.stringify(payload)); const sig=crypto.createHmac("sha256",MCP_TOKEN_SECRET).update(body).digest("base64url"); return `${body}.${sig}`; }
function verify(token) {
  if (!token || !token.includes(".")) throw new Error("invalid_token");
  const [body,sig]=token.split("."); const expected=crypto.createHmac("sha256",MCP_TOKEN_SECRET).update(body).digest(); const got=Buffer.from(sig,"base64url");
  if (expected.length!==got.length || !crypto.timingSafeEqual(expected,got)) throw new Error("invalid_token");
  const p=JSON.parse(Buffer.from(body,"base64url").toString("utf8")); if (!p.exp || p.exp < Math.floor(Date.now()/1000)) throw new Error("expired_token"); return p;
}
function validRedirect(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "chatgpt.com" && (u.pathname.startsWith("/connector/oauth/") || u.pathname === "/connector_platform_oauth_redirect");
  } catch { return false; }
}
function addQuery(url,params) { const u=new URL(url); for (const [k,v] of Object.entries(params)) if (v!==undefined && v!==null && v!=="") u.searchParams.set(k,v); return u.toString(); }
function requestedScopes(v) { const s=String(v||SCOPE).split(/\s+/).filter(Boolean); return s.includes(SCOPE) ? s : [SCOPE]; }

function decodeRegisteredClient(clientId) {
  try { const p=verify(clientId); return p.typ === "client" ? p : null; } catch { return null; }
}
function clientAllows(clientId, redirectUri) {
  const c = decodeRegisteredClient(clientId);
  if (c) return Array.isArray(c.redirect_uris) && c.redirect_uris.includes(redirectUri);
  // Backward-compatible fallback for already-open CIMD flows.
  try { const u=new URL(clientId); return u.protocol==="https:" && u.hostname==="chatgpt.com" && u.pathname.endsWith("/client.json") && validRedirect(redirectUri); } catch { return false; }
}

async function handleRegister(req,res) {
  if (req.method !== "POST") { res.writeHead(405,{allow:"POST"}); return res.end(); }
  const p = await parseBody(req);
  const redirectUris = Array.isArray(p.redirect_uris) ? p.redirect_uris : [];
  if (!redirectUris.length || !redirectUris.every(validRedirect)) return json(res,400,{error:"invalid_redirect_uri"});
  if (p.token_endpoint_auth_method && p.token_endpoint_auth_method !== "none") return json(res,400,{error:"invalid_client_metadata",error_description:"Public PKCE client required."});
  const now=Math.floor(Date.now()/1000);
  const metadata={
    typ:"client", iat:now, exp:now+365*24*3600,
    redirect_uris:redirectUris,
    token_endpoint_auth_method:"none",
    grant_types:Array.isArray(p.grant_types)&&p.grant_types.length?p.grant_types:["authorization_code","refresh_token"],
    response_types:Array.isArray(p.response_types)&&p.response_types.length?p.response_types:["code"],
    application_type:p.application_type||"web",
    client_name:p.client_name||"ChatGPT",
  };
  const clientId=sign(metadata);
  console.log("oauth_register","ok",redirectUris.length);
  return json(res,201,{
    client_id:clientId,
    client_id_issued_at:now,
    redirect_uris:metadata.redirect_uris,
    token_endpoint_auth_method:"none",
    grant_types:metadata.grant_types,
    response_types:metadata.response_types,
    application_type:metadata.application_type,
    client_name:metadata.client_name,
  });
}

function oauthForm(p,error="") {
  const fields=["client_id","redirect_uri","response_type","code_challenge","code_challenge_method","state","resource","scope"].map(k=>`<input type="hidden" name="${k}" value="${esc(p[k]||"")}">`).join("\n");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CHK Binance</title><style>body{margin:0;background:#0b0e11;color:#fff;font-family:system-ui;display:grid;place-items:center;min-height:100vh}.card{width:min(420px,calc(100% - 32px));background:#181a20;border:1px solid #2b3139;border-radius:22px;padding:24px;box-sizing:border-box}h1{font-size:25px;margin:0 0 8px}.gold{color:#f0b90b}.muted{color:#929aa6;line-height:1.5;font-size:14px}label{display:block;margin:22px 0 8px;font-weight:700}input[type=password]{width:100%;box-sizing:border-box;padding:14px;border:2px solid #fff;border-radius:12px;background:#0b0e11;color:#fff;font-size:18px}button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#f0b90b;color:#111;font-weight:800;font-size:16px}.err{color:#ff6670}</style></head><body><main class="card"><h1><span class="gold">CHK</span> Binance</h1><p class="muted">Autorise ChatGPT à lire le dernier instantané synchronisé par ton APK. Aucun ordre, achat, vente ou retrait n’est possible.</p>${error?`<p class="err">${esc(error)}</p>`:""}<form method="post" action="/authorize">${fields}<label for="pin">Code privé MCP</label><input id="pin" name="pin" type="password" inputmode="numeric" required autofocus><button type="submit">Autoriser ChatGPT</button></form><p class="muted">Accès en lecture seule • La clé secrète Binance reste sur ton téléphone.</p></main></body></html>`;
}
function validateAuthorize(p,base) {
  if (p.response_type !== "code") return "response_type non pris en charge";
  if (!validRedirect(p.redirect_uri)) return "redirect_uri ChatGPT invalide";
  if (!clientAllows(p.client_id,p.redirect_uri)) return "client_id non enregistré";
  if (!p.code_challenge || p.code_challenge_method !== "S256") return "PKCE S256 obligatoire";
  if (p.resource && !normalizeResource(p.resource,base)) return "resource invalide";
  if (!requestedScopes(p.scope).includes(SCOPE)) return "scope portfolio:read obligatoire";
  return null;
}
async function handleAuthorize(req,res,base) {
  if (req.method === "GET") {
    const u=new URL(req.url,base), p=Object.fromEntries(u.searchParams.entries()), err=validateAuthorize(p,base);
    console.log("oauth_authorize_get",err?`error:${err}`:"ok");
    return html(res,err?400:200,oauthForm(p,err||""));
  }
  if (req.method === "POST") {
    const p=await parseBody(req), err=validateAuthorize(p,base);
    if (err) { console.log("oauth_authorize_post","params_error",err); return html(res,400,oauthForm(p,err)); }
    if (!constantEqual(p.pin,MCP_LOGIN_PIN)) { console.log("oauth_authorize_post","pin_error"); return html(res,401,oauthForm(p,"Code privé incorrect.")); }
    const code=randomId(32); const now=Math.floor(Date.now()/1000); const scope=requestedScopes(p.scope).join(" ");
    authCodes.set(code,{exp:now+300,client_id:p.client_id,redirect_uri:p.redirect_uri,code_challenge:p.code_challenge,resource:normalizeResource(p.resource,base)||resourceUrl(base),scope});
    const location=addQuery(p.redirect_uri,{code,state:p.state||undefined,iss:base});
    console.log("oauth_authorize_post","redirect_ok",new URL(p.redirect_uri).pathname,"short_code");
    res.writeHead(302,{location,"cache-control":"no-store"}); return res.end();
  }
  res.writeHead(405,{allow:"GET, POST"}); res.end();
}

async function handleToken(req,res,base) {
  if (req.method !== "POST") { res.writeHead(405,{allow:"POST"}); return res.end(); }
  const p=await parseBody(req), now=Math.floor(Date.now()/1000);
  try {
    if (p.grant_type === "authorization_code") {
      const c=authCodes.get(String(p.code||""));
      if (!c || c.exp < now) throw new Error("invalid_grant");
      if (p.client_id && p.client_id !== c.client_id) throw new Error("invalid_client");
      if (p.redirect_uri && p.redirect_uri !== c.redirect_uri) throw new Error("invalid_grant");
      if (!p.code_verifier || sha256(p.code_verifier) !== c.code_challenge) throw new Error("invalid_grant");
      const resource=normalizeResource(p.resource,base)||c.resource; if (resource !== resourceUrl(base)) throw new Error("invalid_target");
      authCodes.delete(String(p.code||""));
      const access=sign({typ:"access",sub:"chk-binance-owner",aud:resourceUrl(base),scope:c.scope||SCOPE,client_id:c.client_id,iat:now,exp:now+3600,jti:randomId()});
      const refresh=sign({typ:"refresh",sub:"chk-binance-owner",aud:resourceUrl(base),scope:c.scope||SCOPE,client_id:c.client_id,iat:now,exp:now+30*86400,jti:randomId()});
      console.log("oauth_token","authorization_code_ok");
      return json(res,200,{access_token:access,token_type:"Bearer",expires_in:3600,refresh_token:refresh,scope:c.scope||SCOPE});
    }
    if (p.grant_type === "refresh_token") {
      const r=verify(p.refresh_token); if (r.typ!=="refresh") throw new Error("invalid_grant"); if (p.client_id && p.client_id!==r.client_id) throw new Error("invalid_client");
      const resource=normalizeResource(p.resource,base)||r.aud; if (resource!==resourceUrl(base)) throw new Error("invalid_target");
      const access=sign({typ:"access",sub:r.sub,aud:resourceUrl(base),scope:r.scope||SCOPE,client_id:r.client_id,iat:now,exp:now+3600,jti:randomId()});
      const refresh=sign({typ:"refresh",sub:r.sub,aud:resourceUrl(base),scope:r.scope||SCOPE,client_id:r.client_id,iat:now,exp:now+30*86400,jti:randomId()});
      console.log("oauth_token","refresh_token_ok");
      return json(res,200,{access_token:access,token_type:"Bearer",expires_in:3600,refresh_token:refresh,scope:r.scope||SCOPE});
    }
    return json(res,400,{error:"unsupported_grant_type"});
  } catch (e) { console.log("oauth_token","error",e.message); return json(res,400,{error:["invalid_client","invalid_target"].includes(e.message)?e.message:"invalid_grant",error_description:"Échec de validation OAuth."}); }
}

async function fetchLatestSnapshot() {
  const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/chk_binance_mcp_latest`,{method:"POST",headers:{"content-type":"application/json","apikey":SUPABASE_ANON_KEY,"authorization":`Bearer ${SUPABASE_ANON_KEY}`},body:JSON.stringify({p_token:MCP_READ_TOKEN})});
  const text=await r.text(); if(!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0,200)}`); let d=JSON.parse(text||"null"); if(Array.isArray(d)&&d.length===1)d=d[0]; if(!d?.snapshot) throw new Error("Aucun instantané Binance synchronisé"); return d;
}
function portfolioSummary(d) { const s=d.snapshot||{}, assets=Array.isArray(s.assets)?s.assets:[]; return {syncedAt:d.created_at,capturedAt:s.capturedAt||null,totalEur:s.totalEur??null,totalUsdt:s.totalUsdt??null,eurUsdt:s.eurUsdt??null,source:s.source||null,assetCount:assets.length,topAssets:[...assets].filter(a=>Number(a.valueEur||0)>0).sort((a,b)=>Number(b.valueEur||0)-Number(a.valueEur||0)).slice(0,5).map(a=>({asset:a.asset,amount:a.amount,valueEur:a.valueEur,valueUsdt:a.valueUsdt}))}; }
const annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true};
const tools=[
  {name:"get_portfolio_summary",title:"Résumé du portefeuille Binance",description:"Use this when the user asks for the current total value, overall Binance portfolio status, or largest holdings from the APK-synchronized snapshot.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations},
  {name:"list_assets",title:"Lister les cryptos du portefeuille",description:"Use this when the user asks which crypto assets are held, their quantities, or their EUR/USDT values.",inputSchema:{type:"object",properties:{top_n:{type:"integer",minimum:1,maximum:50,default:20}},additionalProperties:false},annotations},
  {name:"get_asset",title:"Consulter une crypto",description:"Use this when the user asks about one specific crypto asset held in the synchronized Binance portfolio.",inputSchema:{type:"object",properties:{symbol:{type:"string",minLength:1,maxLength:20}},required:["symbol"],additionalProperties:false},annotations},
  {name:"get_latest_snapshot",title:"Lire le dernier instantané complet",description:"Use this when detailed analysis requires the full latest portfolio snapshot synchronized by the Android APK.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations}
];
async function callTool(name,args={}) { const d=await fetchLatestSnapshot(), s=d.snapshot||{}, assets=Array.isArray(s.assets)?[...s.assets]:[]; assets.sort((a,b)=>Number(b.valueEur||0)-Number(a.valueEur||0)); if(name==="get_portfolio_summary")return{content:[{type:"text",text:"Résumé du dernier portefeuille Binance synchronisé."}],structuredContent:portfolioSummary(d)}; if(name==="list_assets"){const n=Math.max(1,Math.min(50,Number(args.top_n||20)));return{content:[{type:"text",text:`${Math.min(n,assets.length)} actifs du dernier instantané.`}],structuredContent:{syncedAt:d.created_at,totalEur:s.totalEur,totalUsdt:s.totalUsdt,assets:assets.slice(0,n)}};} if(name==="get_asset"){const sym=String(args.symbol||"").trim().toUpperCase(),a=assets.find(x=>String(x.asset).toUpperCase()===sym)||null;return{content:[{type:"text",text:a?`${sym} est présent dans le dernier instantané.`:`${sym} n’apparaît pas dans le dernier instantané.`}],structuredContent:{syncedAt:d.created_at,found:!!a,asset:a}};} if(name==="get_latest_snapshot")return{content:[{type:"text",text:"Dernier instantané complet du portefeuille."}],structuredContent:{syncedAt:d.created_at,snapshot:s}}; throw new Error(`Outil inconnu: ${name}`); }
async function rpc(m) { if(!m||m.jsonrpc!=="2.0")return{jsonrpc:"2.0",id:m?.id??null,error:{code:-32600,message:"Invalid Request"}}; if(m.method==="initialize")return{jsonrpc:"2.0",id:m.id,result:{protocolVersion:m.params?.protocolVersion||"2025-06-18",capabilities:{tools:{listChanged:false}},serverInfo:{name:"chk-binance-apk",version:"1.3.0"},instructions:"Read-only Binance portfolio snapshots synchronized by the CHK Android APK."}}; if(m.method==="ping")return{jsonrpc:"2.0",id:m.id,result:{}}; if(m.method==="tools/list")return{jsonrpc:"2.0",id:m.id,result:{tools}}; if(m.method==="tools/call"){try{return{jsonrpc:"2.0",id:m.id,result:await callTool(m.params?.name,m.params?.arguments||{})};}catch(e){return{jsonrpc:"2.0",id:m.id,result:{isError:true,content:[{type:"text",text:`Erreur MCP CHK Binance : ${String(e.message||e).slice(0,250)}`}]}};}} if(m.id==null)return null; return{jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Method not found"}}; }
function authFromRequest(req,base) { const h=String(req.headers.authorization||""); if(!h.startsWith("Bearer ")) throw new Error("missing_token"); const p=verify(h.slice(7)); if(p.typ!=="access"||p.aud!==resourceUrl(base)||!String(p.scope||"").split(/\s+/).includes(SCOPE)) throw new Error("invalid_token"); return p; }
function unauthorized(res,base) { return json(res,401,{error:"invalid_token",error_description:"Authorization required"},{"www-authenticate":`Bearer resource_metadata="${protectedMetadataUrl(base)}", scope="${SCOPE}"`}); }
async function handleMcp(req,res,base) { try{authFromRequest(req,base);}catch{return unauthorized(res,base);} if(req.method!=="POST"){res.writeHead(405,{allow:"POST"});return res.end();} let parsed;try{parsed=JSON.parse(await bodyText(req));}catch{return json(res,400,{jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}});} if(Array.isArray(parsed)){const out=(await Promise.all(parsed.map(rpc))).filter(Boolean);if(!out.length){res.writeHead(202);return res.end();}return json(res,200,out,{"mcp-protocol-version":"2025-06-18"});} const out=await rpc(parsed);if(!out){res.writeHead(202);return res.end();}return json(res,200,out,{"mcp-protocol-version":"2025-06-18"}); }

const server=http.createServer(async(req,res)=>{try{const base=baseUrl(req),u=new URL(req.url,base);
  if(u.pathname==="/health")return json(res,200,{ok:true,name:"chk-binance-mcp",auth:"oauth2-dcr",readOnly:true,version:"1.3.0"});
  if(u.pathname==="/.well-known/oauth-protected-resource"||u.pathname==="/.well-known/oauth-protected-resource/mcp")return json(res,200,{resource:resourceUrl(base),authorization_servers:[base],scopes_supported:[SCOPE,OFFLINE_SCOPE],bearer_methods_supported:["header"],resource_documentation:`${base}/`});
  if(u.pathname==="/.well-known/oauth-authorization-server")return json(res,200,{issuer:base,authorization_endpoint:`${base}/authorize`,token_endpoint:`${base}/token`,registration_endpoint:`${base}/register`,authorization_response_iss_parameter_supported:true,response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],scopes_supported:[SCOPE,OFFLINE_SCOPE]});
  if(u.pathname==="/register")return handleRegister(req,res);
  if(u.pathname==="/authorize")return handleAuthorize(req,res,base);
  if(u.pathname==="/token")return handleToken(req,res,base);
  if(u.pathname==="/mcp")return handleMcp(req,res,base);
  if(u.pathname==="/")return html(res,200,`<!doctype html><html><body style="background:#0b0e11;color:white;font-family:system-ui;padding:32px"><h1>CHK Binance MCP</h1><p>Serveur privé en lecture seule.</p><p>Endpoint: <code>${esc(resourceUrl(base))}</code></p><p>Version 1.3.0</p></body></html>`);
  return json(res,404,{error:"not_found"});
}catch(e){console.error("request_error",e.message||e);return json(res,500,{error:"server_error"});}});
server.listen(PORT,"0.0.0.0",()=>console.log(`CHK Binance MCP v1.3 listening on :${PORT}`));
