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

for (const [k,v] of Object.entries({SUPABASE_URL,SUPABASE_ANON_KEY,MCP_READ_TOKEN,MCP_TOKEN_SECRET,MCP_LOGIN_PIN})) {
  if (!v) { console.error(`Missing ${k}`); process.exit(1); }
}

function baseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, "");
}
function resourceUrl(base){ return `${base}/mcp`; }
function normalizeResource(value, base) {
  if (!value || value === base || value === `${base}/`) return resourceUrl(base);
  if (value === resourceUrl(base) || value === `${resourceUrl(base)}/`) return resourceUrl(base);
  return null;
}
function json(res,status,data,headers={}) {
  const body=JSON.stringify(data);
  res.writeHead(status,{"content-type":"application/json; charset=utf-8","cache-control":"no-store","content-length":Buffer.byteLength(body),...headers});
  res.end(body);
}
function html(res,status,body){
  res.writeHead(status,{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
  res.end(body);
}
function esc(v=""){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function bodyText(req){let b="";for await(const c of req){b+=c;if(b.length>1_000_000)throw new Error("too_large");}return b;}
async function parseBody(req){
  const raw=await bodyText(req); const ct=String(req.headers["content-type"]||"");
  if (ct.includes("application/json")) { try { return JSON.parse(raw||"{}"); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}
function b64(v){return Buffer.from(v).toString("base64url");}
function sign(payload){const body=b64(JSON.stringify(payload));const sig=crypto.createHmac("sha256",MCP_TOKEN_SECRET).update(body).digest("base64url");return `${body}.${sig}`;}
function verify(token){
  if(!token||!token.includes("."))throw new Error("invalid_token");
  const [body,sig]=token.split(".");
  const expected=crypto.createHmac("sha256",MCP_TOKEN_SECRET).update(body).digest();
  const got=Buffer.from(sig,"base64url");
  if(expected.length!==got.length||!crypto.timingSafeEqual(expected,got))throw new Error("invalid_token");
  const p=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));
  if(!p.exp||p.exp<Math.floor(Date.now()/1000))throw new Error("expired_token");
  return p;
}
function randomId(n=18){return crypto.randomBytes(n).toString("base64url");}
function sha256(v){return crypto.createHash("sha256").update(v).digest("base64url");}
function validChatGptClientId(value){try{const u=new URL(value);return u.protocol==="https:"&&u.hostname==="chatgpt.com"&&u.pathname.endsWith("/client.json");}catch{return false;}}
function validRedirect(value){try{const u=new URL(value);return u.protocol==="https:"&&u.hostname==="chatgpt.com";}catch{return false;}}
function addQuery(url,params){const u=new URL(url);for(const[k,v]of Object.entries(params))if(v!==undefined&&v!==null&&v!=="")u.searchParams.set(k,v);return u.toString();}
function constantEqual(a,b){const A=Buffer.from(String(a||"")),B=Buffer.from(String(b||""));return A.length===B.length&&crypto.timingSafeEqual(A,B);}

function oauthForm(p,error=""){
  const fields=["client_id","redirect_uri","response_type","code_challenge","code_challenge_method","state","resource","scope"].map(k=>`<input type="hidden" name="${k}" value="${esc(p[k]||"")}">`).join("\n");
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CHK Binance</title><style>body{margin:0;background:#0b0e11;color:#fff;font-family:system-ui;display:grid;place-items:center;min-height:100vh}.card{width:min(420px,calc(100% - 32px));background:#181a20;border:1px solid #2b3139;border-radius:22px;padding:24px;box-sizing:border-box}h1{font-size:25px}.gold{color:#f0b90b}.muted{color:#929aa6;line-height:1.5}label{display:block;margin:22px 0 8px;font-weight:700}input{width:100%;box-sizing:border-box;padding:14px;border:2px solid #fff;border-radius:12px;background:#0b0e11;color:#fff;font-size:18px}button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#f0b90b;font-weight:800;font-size:16px}.err{color:#ff6670}</style></head><body><main class="card"><h1><span class="gold">CHK</span> Binance</h1><p class="muted">Autorise ChatGPT à lire le dernier instantané synchronisé par ton APK. Aucun ordre, achat, vente ou retrait n’est possible.</p>${error?`<p class="err">${esc(error)}</p>`:""}<form method="post" action="/authorize">${fields}<label>Code privé MCP</label><input name="pin" type="password" inputmode="numeric" required autofocus><button type="submit">Autoriser ChatGPT</button></form><p class="muted">Accès en lecture seule • La clé secrète Binance reste sur ton téléphone.</p></main></body></html>`;
}
function validateAuth(p,base){
  if(p.response_type!=="code")return "response_type non pris en charge";
  if(!validChatGptClientId(p.client_id))return "client_id ChatGPT invalide";
  if(!validRedirect(p.redirect_uri))return "redirect_uri ChatGPT invalide";
  if(!p.code_challenge||p.code_challenge_method!=="S256")return "PKCE S256 obligatoire";
  if(p.resource&&!normalizeResource(p.resource,base))return "resource invalide";
  if(!String(p.scope||SCOPE).split(/\s+/).includes(SCOPE))return "scope portfolio:read obligatoire";
  return null;
}

async function fetchLatest(){
  const r=await fetch(`${SUPABASE_URL}/rest/v1/rpc/chk_binance_mcp_latest`,{method:"POST",headers:{"content-type":"application/json","apikey":SUPABASE_ANON_KEY,"authorization":`Bearer ${SUPABASE_ANON_KEY}`},body:JSON.stringify({p_token:MCP_READ_TOKEN})});
  const text=await r.text(); if(!r.ok)throw new Error(`Supabase ${r.status}`);
  let d=JSON.parse(text||"null"); if(Array.isArray(d)&&d.length===1)d=d[0]; if(!d?.snapshot)throw new Error("Aucun instantané Binance"); return d;
}
function summary(d){const s=d.snapshot||{},assets=Array.isArray(s.assets)?s.assets:[];return{syncedAt:d.created_at,totalEur:s.totalEur??null,totalUsdt:s.totalUsdt??null,assetCount:assets.length,topAssets:[...assets].sort((a,b)=>Number(b.valueEur||0)-Number(a.valueEur||0)).slice(0,5)};}
const tools=[
{name:"get_portfolio_summary",title:"Résumé du portefeuille Binance",description:"Use this when the user asks for the current total value or largest holdings from the APK-synchronized Binance snapshot.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true}},
{name:"list_assets",title:"Lister les cryptos",description:"Use this when the user asks which crypto assets are held and their values.",inputSchema:{type:"object",properties:{top_n:{type:"integer",minimum:1,maximum:50,default:20}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true}},
{name:"get_asset",title:"Consulter une crypto",description:"Use this when the user asks about one specific crypto asset in the synchronized portfolio.",inputSchema:{type:"object",properties:{symbol:{type:"string"}},required:["symbol"],additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true}},
{name:"get_latest_snapshot",title:"Lire le dernier instantané",description:"Use this when detailed analysis requires the full latest portfolio snapshot synchronized by the Android APK.",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false,idempotentHint:true}}
];
async function callTool(name,args={}){const d=await fetchLatest(),s=d.snapshot,assets=[...(s.assets||[])].sort((a,b)=>Number(b.valueEur||0)-Number(a.valueEur||0));if(name==="get_portfolio_summary")return{content:[{type:"text",text:"Résumé du dernier portefeuille synchronisé."}],structuredContent:summary(d)};if(name==="list_assets"){const n=Math.max(1,Math.min(50,Number(args.top_n||20)));return{content:[{type:"text",text:`${Math.min(n,assets.length)} actifs.`}],structuredContent:{syncedAt:d.created_at,totalEur:s.totalEur,totalUsdt:s.totalUsdt,assets:assets.slice(0,n)}};}if(name==="get_asset"){const sym=String(args.symbol||"").toUpperCase(),a=assets.find(x=>String(x.asset).toUpperCase()===sym);return{content:[{type:"text",text:a?`${sym} trouvé.`:`${sym} absent.`}],structuredContent:{syncedAt:d.created_at,found:!!a,asset:a||null}};}if(name==="get_latest_snapshot")return{content:[{type:"text",text:"Dernier instantané complet."}],structuredContent:{syncedAt:d.created_at,snapshot:s}};throw new Error("Outil inconnu");}
async function rpc(msg){if(!msg||msg.jsonrpc!=="2.0")return{jsonrpc:"2.0",id:msg?.id??null,error:{code:-32600,message:"Invalid Request"}};if(msg.method==="initialize")return{jsonrpc:"2.0",id:msg.id,result:{protocolVersion:msg.params?.protocolVersion||"2025-06-18",capabilities:{tools:{listChanged:false}},serverInfo:{name:"chk-binance-apk",version:"1.1.0"},instructions:"Read-only Binance portfolio snapshots synchronized by the CHK APK."}};if(msg.method==="ping")return{jsonrpc:"2.0",id:msg.id,result:{}};if(msg.method==="tools/list")return{jsonrpc:"2.0",id:msg.id,result:{tools}};if(msg.method==="tools/call"){try{return{jsonrpc:"2.0",id:msg.id,result:await callTool(msg.params?.name,msg.params?.arguments||{})};}catch(e){return{jsonrpc:"2.0",id:msg.id,result:{isError:true,content:[{type:"text",text:`Erreur: ${String(e.message||e).slice(0,200)}`}]}};}}if(msg.id==null)return null;return{jsonrpc:"2.0",id:msg.id,error:{code:-32601,message:"Method not found"}};}

function authFromReq(req,base){const h=String(req.headers.authorization||"");if(!h.startsWith("Bearer "))throw new Error("missing");const p=verify(h.slice(7));if(p.typ!=="access"||normalizeResource(p.aud,base)!==resourceUrl(base))throw new Error("aud");return p;}
function unauthorized(res,base){return json(res,401,{error:"unauthorized"},{"www-authenticate":`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="${SCOPE}"`});}

async function handleMcp(req,res,base){try{authFromReq(req,base);}catch{return unauthorized(res,base);}if(req.method!=="POST"){res.writeHead(405,{allow:"POST"});return res.end();}let parsed;try{parsed=JSON.parse(await bodyText(req));}catch{return json(res,400,{jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}});}if(Array.isArray(parsed)){const out=(await Promise.all(parsed.map(rpc))).filter(Boolean);return json(res,out.length?200:202,out,{"mcp-protocol-version":"2025-06-18"});}const out=await rpc(parsed);if(!out){res.writeHead(202);return res.end();}return json(res,200,out,{"mcp-protocol-version":"2025-06-18"});}

async function handleAuthorize(req,res,base){
  if(req.method==="GET"){const u=new URL(req.url,base),p=Object.fromEntries(u.searchParams.entries()),err=validateAuth(p,base);console.log("oauth_authorize_get",err?`error:${err}`:"ok");return html(res,err?400:200,oauthForm(p,err||""));}
  if(req.method==="POST"){const p=await parseBody(req),err=validateAuth(p,base);if(err){console.log("oauth_authorize_post","params_error",err);return html(res,400,oauthForm(p,err));}if(!constantEqual(p.pin,MCP_LOGIN_PIN)){console.log("oauth_authorize_post","pin_error");return html(res,401,oauthForm(p,"Code privé incorrect."));}const now=Math.floor(Date.now()/1000),resource=normalizeResource(p.resource,base)||resourceUrl(base),code=sign({typ:"code",iat:now,exp:now+300,jti:randomId(),client_id:p.client_id,redirect_uri:p.redirect_uri,code_challenge:p.code_challenge,resource,scope:SCOPE});const location=addQuery(p.redirect_uri,{code,state:p.state||undefined});console.log("oauth_authorize_post","redirect_ok",new URL(p.redirect_uri).pathname);res.writeHead(302,{location,"cache-control":"no-store"});return res.end();}
  res.writeHead(405,{allow:"GET, POST"});res.end();
}

async function handleToken(req,res,base){if(req.method!=="POST"){res.writeHead(405,{allow:"POST"});return res.end();}const p=await parseBody(req),now=Math.floor(Date.now()/1000);try{if(p.grant_type==="authorization_code"){const c=verify(p.code);if(c.typ!=="code")throw new Error("invalid_grant");if(p.client_id&&p.client_id!==c.client_id)throw new Error("invalid_client");if(p.redirect_uri&&p.redirect_uri!==c.redirect_uri)throw new Error("invalid_grant");if(!p.code_verifier||sha256(p.code_verifier)!==c.code_challenge)throw new Error("invalid_grant");const resource=normalizeResource(p.resource,base)||c.resource;if(normalizeResource(resource,base)!==resourceUrl(base))throw new Error("invalid_target");const access_token=sign({typ:"access",sub:"chk-binance-owner",aud:resourceUrl(base),scope:SCOPE,client_id:c.client_id,iat:now,exp:now+3600,jti:randomId()});const refresh_token=sign({typ:"refresh",sub:"chk-binance-owner",aud:resourceUrl(base),scope:SCOPE,client_id:c.client_id,iat:now,exp:now+30*86400,jti:randomId()});console.log("oauth_token","authorization_code_ok");return json(res,200,{access_token,token_type:"Bearer",expires_in:3600,refresh_token,scope:SCOPE});}if(p.grant_type==="refresh_token"){const r=verify(p.refresh_token);if(r.typ!=="refresh")throw new Error("invalid_grant");const access_token=sign({typ:"access",sub:r.sub,aud:resourceUrl(base),scope:SCOPE,client_id:r.client_id,iat:now,exp:now+3600,jti:randomId()});const refresh_token=sign({typ:"refresh",sub:r.sub,aud:resourceUrl(base),scope:SCOPE,client_id:r.client_id,iat:now,exp:now+30*86400,jti:randomId()});return json(res,200,{access_token,token_type:"Bearer",expires_in:3600,refresh_token,scope:SCOPE});}return json(res,400,{error:"unsupported_grant_type"});}catch(e){console.log("oauth_token","error",e.message);return json(res,400,{error:["invalid_client","invalid_target"].includes(e.message)?e.message:"invalid_grant",error_description:"Échec de validation OAuth."});}}

const server=http.createServer(async(req,res)=>{try{const base=baseUrl(req),u=new URL(req.url,base);if(u.pathname==="/health")return json(res,200,{ok:true,name:"chk-binance-mcp",auth:"oauth2",version:"1.1.0"});if(u.pathname==="/.well-known/oauth-protected-resource"||u.pathname==="/.well-known/oauth-protected-resource/mcp")return json(res,200,{resource:resourceUrl(base),authorization_servers:[base],scopes_supported:[SCOPE],bearer_methods_supported:["header"],resource_documentation:`${base}/`});if(u.pathname==="/.well-known/oauth-authorization-server")return json(res,200,{issuer:base,authorization_endpoint:`${base}/authorize`,token_endpoint:`${base}/token`,client_id_metadata_document_supported:true,response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],token_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],scopes_supported:[SCOPE]});if(u.pathname==="/authorize")return handleAuthorize(req,res,base);if(u.pathname==="/token")return handleToken(req,res,base);if(u.pathname==="/mcp")return handleMcp(req,res,base);if(u.pathname==="/")return html(res,200,`<!doctype html><html><body style="background:#0b0e11;color:white;font-family:system-ui;padding:32px"><h1>CHK Binance MCP</h1><p>Serveur privé en lecture seule.</p><p>Endpoint: <code>${esc(resourceUrl(base))}</code></p></body></html>`);return json(res,404,{error:"not_found"});}catch(e){console.error("request_error",e.message);return json(res,500,{error:"server_error"});}});
server.listen(PORT,"0.0.0.0",()=>console.log(`CHK Binance MCP v1.1 listening on :${PORT}`));
