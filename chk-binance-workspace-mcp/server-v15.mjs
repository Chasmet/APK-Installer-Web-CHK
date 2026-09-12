import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT=Number(process.env.PORT||3000);
const UPSTREAM_PORT=Number(process.env.V15_UPSTREAM_PORT||(PORT+10));
const SERVER_VERSION='15.2.0';
const BYBIT_API_KEY=String(process.env.BYBIT_API_KEY||'').trim();
const CHK_INTERNAL_TOKEN=String(process.env.CHK_INTERNAL_TOKEN||'');
const MCP_LINK_TOKEN=String(process.env.MCP_LINK_TOKEN||'');
const EDGE_URL=String(process.env.SUPABASE_EDGE_URL||'');
const here=path.dirname(fileURLToPath(import.meta.url));

if(!BYBIT_API_KEY) throw new Error('BYBIT_API_KEY missing');
if(!CHK_INTERNAL_TOKEN) throw new Error('CHK_INTERNAL_TOKEN missing');
if(!MCP_LINK_TOKEN) throw new Error('MCP_LINK_TOKEN missing');
if(!EDGE_URL) throw new Error('SUPABASE_EDGE_URL missing');

const child=spawn(process.execPath,['server-v14.mjs'],{cwd:here,env:{...process.env,PORT:String(UPSTREAM_PORT),V14_UPSTREAM_PORT:String(UPSTREAM_PORT+10)},stdio:['ignore','inherit','inherit']});
child.on('exit',(code,signal)=>console.error(`v14 exited code=${code} signal=${signal}`));

function sha256(v){return crypto.createHash('sha256').update(String(v)).digest('hex');}
function constantEqual(a,b){const A=Buffer.from(String(a||''));const B=Buffer.from(String(b||''));return A.length===B.length&&crypto.timingSafeEqual(A,B);}
function validLegacyMcpPath(p){return p.startsWith('/mcp/')&&constantEqual(p.slice(5),MCP_LINK_TOKEN);}
function isCanonicalMcpPath(p){return p==='/mcp'||validLegacyMcpPath(p);}
function json(res,status,data,extra={}){const body=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body),...extra});res.end(body);}
async function bodyText(req,max=1_000_000){let body='';for await(const chunk of req){body+=chunk;if(body.length>max)throw new Error('request_too_large');}return body;}
function bridgeUrl(){const u=new URL(EDGE_URL);u.pathname=u.pathname.replace(/\/chk-binance-workspace-latest\/?$/,`/chk-mcp-bridge`);return u.toString();}
async function bridge(payload){const r=await fetch(bridgeUrl(),{method:'POST',headers:{'content-type':'application/json','x-chk-internal-token':CHK_INTERNAL_TOKEN,accept:'application/json','user-agent':'chk-crypto-workspace-v15.2'},body:JSON.stringify(payload)});const text=await r.text();let data;try{data=JSON.parse(text||'{}');}catch{data={raw:text};}if(!r.ok)throw new Error(`chk-mcp-bridge ${r.status}: ${data?.error||data?.message||text.slice(0,180)}`);return data;}
async function upstreamRpc(msg){const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/mcp`,{method:'POST',headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18',accept:'application/json'},body:JSON.stringify(msg)});const text=await r.text();if(!r.ok)throw new Error(`v14 ${r.status}: ${text.slice(0,180)}`);return JSON.parse(text||'{}');}
function result(id,data,text){return{jsonrpc:'2.0',id,result:{content:[{type:'text',text}],structuredContent:data}};}
function cleanSymbol(v){const s=String(v||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,30);if(!s.endsWith('USDC')||s==='USDCUSDC')throw new Error('Seules les paires CRYPTO/USDC sont autorisées');return s;}

const alertTools=[
 {name:'create_alert',title:'Créer une alarme CHK Crypto',description:'Crée une vraie alarme de prix dans l’onglet Alarmes de CHK Crypto. Le téléphone la synchronise et surveille ensuite le prix Bybit public.',inputSchema:{type:'object',properties:{symbol:{type:'string'},condition:{type:'string',enum:['above','below']},target_price:{type:'number',exclusiveMinimum:0},label:{type:'string'},rationale:{type:'string'},one_shot:{type:'boolean'}},required:['symbol','condition','target_price'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}},
 {name:'list_alerts',title:'Lister les alarmes CHK Crypto',description:'Liste les alarmes de prix CHK Crypto, actives ou déclenchées.',inputSchema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:200}},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'update_alert',title:'Modifier une alarme CHK Crypto',description:'Modifie le seuil, la condition, le libellé, l’état actif ou le mode one-shot d’une alarme existante.',inputSchema:{type:'object',properties:{id:{type:'string'},condition:{type:'string',enum:['above','below']},target_price:{type:'number',exclusiveMinimum:0},label:{type:'string'},rationale:{type:'string'},enabled:{type:'boolean'},one_shot:{type:'boolean'}},required:['id'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}},
 {name:'delete_alert',title:'Supprimer une alarme CHK Crypto',description:'Supprime réellement une alarme de l’onglet Alarmes CHK Crypto.',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}},
];
const handled=new Set(alertTools.map(t=>t.name));

async function handleOne(msg,requestPath='/mcp'){
 if(msg?.method==='initialize'){
  const out=await upstreamRpc(msg);
  if(out?.result){
   out.result.serverInfo={name:'chk-crypto-workspace',version:SERVER_VERSION};
   out.result.capabilities=out.result.capabilities||{};
   out.result.capabilities.tools={...(out.result.capabilities.tools||{}),listChanged:true};
   out.result.instructions='CHK Crypto v15.2. Le MCP gère portefeuille, marchés, notes, propositions d’ordres, annulations et alarmes. Outils dédiés attendus: create_alert, list_alerts, update_alert, delete_alert. IMPORTANT compatibilité cache ChatGPT: si ces outils ne sont pas visibles mais create_note/list_notes le sont, créer une alarme avec create_note kind=ALERT et content JSON {"symbol":"ADAUSDC","condition":"below","target_price":0.216,"label":"...","rationale":"...","one_shot":true}; modifier avec kind=ALERT_UPDATE et supprimer avec kind=ALERT_DELETE. list_notes retourne également le tableau alerts. Les alarmes sont réellement synchronisées dans l’onglet Alarmes. Aucun ordre réel sans confirmation utilisateur dans l’APK.';
  }
  console.log(`[MCP v15.2] initialize path=${requestPath==='/mcp'?'canonical':'legacy-tokenized'}`);
  return out;
 }
 if(msg?.method==='tools/list'){
  const out=await upstreamRpc(msg);const tools=Array.isArray(out?.result?.tools)?out.result.tools:[];
  for(const t of alertTools)if(!tools.some(x=>x?.name===t.name))tools.push(t);
  if(out?.result)out.result.tools=tools;
  console.log(`[MCP v15.2] tools/list path=${requestPath==='/mcp'?'canonical':'legacy-tokenized'} count=${tools.length} alerts=${alertTools.map(t=>t.name).join(',')}`);
  return out;
 }
 if(msg?.method!=='tools/call')return upstreamRpc(msg);
 const name=String(msg?.params?.name||'');if(!handled.has(name))return upstreamRpc(msg);
 const a=msg?.params?.arguments||{};const accountFingerprint=sha256(BYBIT_API_KEY);
 if(name==='list_alerts'){const d=await bridge({action:'list_alerts',accountFingerprint,limit:a.limit??100});return result(msg.id,d,`Alarmes CHK Crypto: ${Array.isArray(d?.alerts)?d.alerts.length:0}.`);}
 if(name==='create_alert'){const symbol=cleanSymbol(a.symbol);const d=await bridge({action:'create_alert',accountFingerprint,symbol,condition:a.condition,targetPrice:a.target_price,label:a.label??'',rationale:a.rationale??'',oneShot:a.one_shot!==false,enabled:true});return result(msg.id,d,d?.duplicate?'Alarme déjà présente dans CHK Crypto.':'Alarme créée dans CHK Crypto.');}
 if(name==='update_alert'){const d=await bridge({action:'update_alert',accountFingerprint,id:a.id,condition:a.condition,targetPrice:a.target_price,label:a.label,rationale:a.rationale,enabled:a.enabled,oneShot:a.one_shot});return result(msg.id,d,'Alarme CHK Crypto mise à jour.');}
 if(name==='delete_alert'){const d=await bridge({action:'delete_alert',accountFingerprint,id:a.id});return result(msg.id,d,'Alarme CHK Crypto supprimée.');}
 return upstreamRpc(msg);
}
async function proxy(req,res,raw){const target=new URL(req.url,`http://127.0.0.1:${UPSTREAM_PORT}`);const r=await fetch(target,{method:req.method,headers:{...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(req.headers.accept?{accept:req.headers.accept}:{}),...(req.headers['mcp-protocol-version']?{'mcp-protocol-version':req.headers['mcp-protocol-version']}:{})},body:raw});const text=await r.text();res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);}
async function waitForUpstream(){for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('v14_startup_timeout');}
const server=http.createServer(async(req,res)=>{try{const raw=req.method==='GET'||req.method==='HEAD'?undefined:await bodyText(req);const u=new URL(req.url,`https://${req.headers.host}`);
 if(u.pathname.startsWith('/mcp/')&&!validLegacyMcpPath(u.pathname))return json(res,403,{error:'mcp_forbidden'});
 if(isCanonicalMcpPath(u.pathname)&&req.method==='POST'){
  let parsed;try{parsed=JSON.parse(raw||'{}');}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
  const out=Array.isArray(parsed)?await Promise.all(parsed.map(x=>handleOne(x,u.pathname))):await handleOne(parsed,u.pathname);
  return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});
 }
 if(u.pathname==='/health'){let upstream={};try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);upstream=await r.json();}catch{}return json(res,200,{...upstream,gatewayVersion:SERVER_VERSION,alertManagement:true,legacyTokenizedMcpCompat:true,toolListChanged:true,expectedAlertTools:alertTools.map(t=>t.name),alarmCompatibilityViaNotes:true});}
 return proxy(req,res,raw);
}catch(e){console.error('v15_request_error',e?.message||e);return json(res,500,{error:'server_error',message:String(e?.message||e).slice(0,200)});}});
try{await waitForUpstream();server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto Gateway v${SERVER_VERSION} alerts + cached-catalog compatibility on :${PORT}`));}catch(e){console.error(e);child.kill('SIGTERM');process.exit(1);}
