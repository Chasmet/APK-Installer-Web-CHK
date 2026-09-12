import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT=Number(process.env.PORT||3000);
const UPSTREAM_PORT=Number(process.env.V13_UPSTREAM_PORT||(PORT+10));
const SERVER_VERSION='13.1.0';
const EDGE_URL=String(process.env.SUPABASE_EDGE_URL||'');
const CHK_INTERNAL_TOKEN=String(process.env.CHK_INTERNAL_TOKEN||'');
const BYBIT_API_KEY=String(process.env.BYBIT_API_KEY||'').trim();
const here=path.dirname(fileURLToPath(import.meta.url));
const child=spawn(process.execPath,['server-v12.mjs'],{cwd:here,env:{...process.env,PORT:String(UPSTREAM_PORT),V12_UPSTREAM_PORT:String(UPSTREAM_PORT+10)},stdio:['ignore','inherit','inherit']});
child.on('exit',(code,signal)=>console.error(`v12 exited code=${code} signal=${signal}`));

function json(res,status,data,extra={}){const body=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body),...extra});res.end(body);}
async function bodyText(req,max=1_000_000){let body='';for await(const chunk of req){body+=chunk;if(body.length>max)throw new Error('request_too_large');}return body;}
function sha256(v){return crypto.createHash('sha256').update(String(v)).digest('hex');}
function edgeUrl(slug){const u=new URL(EDGE_URL);u.pathname=u.pathname.replace(/\/chk-binance-workspace-latest\/?$/,`/${slug}`);return u.toString();}
async function latestAndroidBybit(){if(!EDGE_URL||!CHK_INTERNAL_TOKEN)throw new Error('snapshot bridge not configured');const r=await fetch(edgeUrl('chk-mcp-snapshot'),{method:'POST',headers:{'content-type':'application/json','x-chk-internal-token':CHK_INTERNAL_TOKEN,accept:'application/json','user-agent':'chk-crypto-v13.1'},body:JSON.stringify({action:'latest_snapshot',exchange:'BYBIT'})});const text=await r.text();let root;try{root=JSON.parse(text||'{}');}catch{root={};}if(!r.ok)throw new Error(`snapshot ${r.status}: ${root?.error||text.slice(0,160)}`);return root?.record||null;}
async function identityDiag(){const record=await latestAndroidBybit();const renderFp=BYBIT_API_KEY?sha256(BYBIT_API_KEY):'';const androidFp=String(record?.account_fingerprint||'');return{renderConfigured:!!renderFp,androidSnapshotFound:!!record,identityMatch:!!renderFp&&!!androidFp&&renderFp===androidFp,renderFingerprintPrefix:renderFp?renderFp.slice(0,12):null,androidFingerprintPrefix:androidFp?androidFp.slice(0,12):null,androidUpdatedAt:record?.updated_at||null,androidAppVersion:record?.app_version||null,androidSource:record?.snapshot?.source||null};}
function portfolioFromSnapshot(record){const s=record?.snapshot||{};const assets=Array.isArray(s.assets)?s.assets:[];return{totalEquity:Number(s.totalUsdt||0),totalUsdt:Number(s.totalUsdt||0),totalEur:Number(s.totalEur||0),assetCount:assets.length,topAssets:assets.slice().sort((a,b)=>Number(b.valueUsdt||0)-Number(a.valueUsdt||0)).slice(0,8),capturedAt:s.capturedAt||null,cached:true,stale:true,source:'android_snapshot_fallback',snapshotUpdatedAt:record?.updated_at||null,warning:'Lecture Bybit Render indisponible ou identité différente; dernier snapshot Android CHK Crypto utilisé.'};}
function assetsFromSnapshot(record,n=20){const s=record?.snapshot||{};const rows=(Array.isArray(s.assets)?s.assets:[]).slice().sort((a,b)=>Number(b.valueUsdt||0)-Number(a.valueUsdt||0)).slice(0,n).map(a=>({coin:a.asset,walletBalance:a.amount,usdValue:a.valueUsdt,priceUsdt:a.priceUsdt}));return{assets:rows,capturedAt:s.capturedAt||null,cached:true,stale:true,source:'android_snapshot_fallback',snapshotUpdatedAt:record?.updated_at||null};}
async function waitForUpstream(){for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('v12_startup_timeout');}
async function upstreamRequest(req,res,raw){const target=new URL(req.url,`http://127.0.0.1:${UPSTREAM_PORT}`);const r=await fetch(target,{method:req.method,headers:{...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(req.headers.accept?{accept:req.headers.accept}:{}),...(req.headers['mcp-protocol-version']?{'mcp-protocol-version':req.headers['mcp-protocol-version']}:{})},body:raw});const text=await r.text();res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);}
async function upstreamRpc(msg){const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/mcp`,{method:'POST',headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18',accept:'application/json'},body:JSON.stringify(msg)});const text=await r.text();if(!r.ok)throw new Error(`upstream_${r.status}: ${text.slice(0,160)}`);return JSON.parse(text||'{}');}
function result(id,data,text){return{jsonrpc:'2.0',id,result:{content:[{type:'text',text}],structuredContent:data}};}
async function handleOne(msg){if(msg?.method==='tools/list'){const out=await upstreamRpc(msg);const tools=Array.isArray(out?.result?.tools)?out.result.tools:[];if(!tools.some(t=>t?.name==='diagnose_bybit_identity'))tools.push({name:'diagnose_bybit_identity',title:'Diagnostic identité Bybit',description:'Compare sans exposer les clés l’empreinte Bybit Render à celle synchronisée par l’APK CHK Crypto.',inputSchema:{type:'object',properties:{},additionalProperties:false}});if(out?.result)out.result.tools=tools;return out;}
 if(msg?.method==='initialize'){const out=await upstreamRpc(msg);if(out?.result){out.result.serverInfo={name:'chk-crypto-workspace',version:SERVER_VERSION};out.result.instructions='CHK Crypto v13.1. Bybit live uses Render credentials; identity snapshot uses the isolated CHK internal bridge. If identity differs from the Android account, portfolio reads fall back to the latest Android CHK Crypto snapshot and are explicitly marked cached/stale.';}return out;}
 if(msg?.method==='tools/call'){
  const name=String(msg?.params?.name||'');const args=msg?.params?.arguments||{};
  if(name==='diagnose_bybit_identity'){const d=await identityDiag();return result(msg.id,d,`Diagnostic identité Bybit: ${d.identityMatch?'correspondance OK':'identités différentes ou incomplètes'}.`);}
  if(name==='get_bybit_portfolio_summary'||name==='list_bybit_assets'||name==='get_workspace_info'){
   let upstream=null;try{upstream=await upstreamRpc(msg);}catch{}
   const isErr=!upstream||upstream?.result?.isError===true;
   let d=null;try{d=await identityDiag();}catch{}
   if(name==='get_workspace_info'&&!isErr){const sc=upstream?.result?.structuredContent||{};sc.bybitIdentity=d;return result(msg.id,sc,`CHK Crypto Workspace v13.1 • dépôt canonique Chasmet/Binance-bybyt- • identité Bybit ${d?.identityMatch?'OK':'à corriger'}.`);}
   if(!isErr&&d?.identityMatch)return upstream;
   const rec=await latestAndroidBybit();
   if(name==='get_bybit_portfolio_summary')return result(msg.id,portfolioFromSnapshot(rec),'Bybit: dernier snapshot Android CHK Crypto utilisé car la clé Render ne correspond pas à la clé active de l’APK ou le live a échoué.');
   if(name==='list_bybit_assets')return result(msg.id,assetsFromSnapshot(rec,Math.max(1,Math.min(50,Number(args.top_n||20)))),'Actifs Bybit issus du dernier snapshot Android CHK Crypto; données marquées stale.');
   const sc=upstream?.result?.structuredContent||{};sc.bybitIdentity=d;sc.bybitFallback=portfolioFromSnapshot(rec);return result(msg.id,sc,'Workspace v13.1: Bybit Render non fiable, fallback Android disponible.');
  }
 }
 return await upstreamRpc(msg);
}
async function handleMcp(req,res,raw){let parsed;try{parsed=JSON.parse(raw||'{}');}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}const out=Array.isArray(parsed)?await Promise.all(parsed.map(handleOne)):await handleOne(parsed);return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});}

const server=http.createServer(async(req,res)=>{try{const raw=req.method==='GET'||req.method==='HEAD'?undefined:await bodyText(req);const u=new URL(req.url,`https://${req.headers.host}`);if(u.pathname==='/mcp'&&req.method==='POST')return handleMcp(req,res,raw);if(u.pathname==='/health'){const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);const h=await r.json();let d=null;try{d=await identityDiag();}catch(e){d={error:String(e.message||e)}}return json(res,200,{...h,gatewayVersion:SERVER_VERSION,bybitIdentity:d});}return upstreamRequest(req,res,raw);}catch(e){console.error('v13_request_error',e?.message||e);return json(res,500,{error:'server_error',message:String(e?.message||e).slice(0,200)});}});
try{await waitForUpstream();server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto Gateway v${SERVER_VERSION} with Bybit identity diagnostics on :${PORT}`));}catch(e){console.error(e);child.kill('SIGTERM');process.exit(1);}
