import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT=Number(process.env.PORT||3000);
const UPSTREAM_PORT=Number(process.env.V14_UPSTREAM_PORT||(PORT+10));
const SERVER_VERSION='14.0.0';
const BYBIT_API_KEY=String(process.env.BYBIT_API_KEY||'').trim();
const CHK_INTERNAL_TOKEN=String(process.env.CHK_INTERNAL_TOKEN||'');
const EDGE_URL=String(process.env.SUPABASE_EDGE_URL||'');
const here=path.dirname(fileURLToPath(import.meta.url));

if(!BYBIT_API_KEY) throw new Error('BYBIT_API_KEY missing');
if(!CHK_INTERNAL_TOKEN) throw new Error('CHK_INTERNAL_TOKEN missing');
if(!EDGE_URL) throw new Error('SUPABASE_EDGE_URL missing');

const child=spawn(process.execPath,['server-v13.mjs'],{cwd:here,env:{...process.env,PORT:String(UPSTREAM_PORT),V13_UPSTREAM_PORT:String(UPSTREAM_PORT+10)},stdio:['ignore','inherit','inherit']});
child.on('exit',(code,signal)=>console.error(`v13 exited code=${code} signal=${signal}`));

function sha256(v){return crypto.createHash('sha256').update(String(v)).digest('hex');}
function json(res,status,data,extra={}){const body=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body),...extra});res.end(body);}
async function bodyText(req,max=1_000_000){let body='';for await(const chunk of req){body+=chunk;if(body.length>max)throw new Error('request_too_large');}return body;}
function bridgeUrl(){const u=new URL(EDGE_URL);u.pathname=u.pathname.replace(/\/chk-binance-workspace-latest\/?$/,`/chk-mcp-bridge`);return u.toString();}
async function bridge(payload){const r=await fetch(bridgeUrl(),{method:'POST',headers:{'content-type':'application/json','x-chk-internal-token':CHK_INTERNAL_TOKEN,accept:'application/json','user-agent':'chk-crypto-workspace-v14'},body:JSON.stringify(payload)});const text=await r.text();let data;try{data=JSON.parse(text||'{}');}catch{data={raw:text};}if(!r.ok)throw new Error(`chk-mcp-bridge ${r.status}: ${data?.error||data?.message||text.slice(0,180)}`);return data;}
async function upstreamRpc(msg){const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/mcp`,{method:'POST',headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18',accept:'application/json'},body:JSON.stringify(msg)});const text=await r.text();if(!r.ok)throw new Error(`v13 ${r.status}: ${text.slice(0,180)}`);return JSON.parse(text||'{}');}
function result(id,data,text){return{jsonrpc:'2.0',id,result:{content:[{type:'text',text}],structuredContent:data}};}
const handled=new Set(['create_note','list_notes','create_trade_proposal','list_trade_proposals','create_cancel_proposal','list_cancel_proposals']);
async function handleOne(msg){
 if(msg?.method==='initialize'){const out=await upstreamRpc(msg);if(out?.result){out.result.serverInfo={name:'chk-crypto-workspace',version:SERVER_VERSION};out.result.instructions='CHK Crypto v14. Bybit EU live via Render. Notes, trade proposals and cancel/replacement proposals use the isolated authenticated CHK MCP bridge. No real order is executed by MCP; confirmation in the APK remains mandatory.';}return out;}
 if(msg?.method!=='tools/call') return upstreamRpc(msg);
 const name=String(msg?.params?.name||'');if(!handled.has(name)) return upstreamRpc(msg);
 const a=msg?.params?.arguments||{};const accountFingerprint=sha256(BYBIT_API_KEY);
 if(name==='list_notes'){const d=await bridge({action:'list_notes',accountFingerprint,limit:a.limit??100});return result(msg.id,d,`Bloc-notes CHK Crypto: ${Array.isArray(d?.notes)?d.notes.length:0} note(s).`);}
 if(name==='create_note'){const d=await bridge({action:'create_note',accountFingerprint,content:a.content,exchange:a.exchange??'GLOBAL',kind:a.kind??'ANALYSIS'});return result(msg.id,d,'Note enregistrée dans CHK Crypto.');}
 if(name==='list_trade_proposals'){const d=await bridge({action:'list_trade_proposals',accountFingerprint,limit:a.limit??40});return result(msg.id,d,`Propositions CHK Crypto: ${Array.isArray(d?.proposals)?d.proposals.length:0}.`);}
 if(name==='create_trade_proposal'){const d=await bridge({action:'create_trade_proposal',accountFingerprint,symbol:a.symbol,side:a.side,orderType:a.order_type,quoteAmountUsdc:a.quote_amount_usdc,baseQuantity:a.base_quantity??null,limitPrice:a.limit_price??null,rationale:a.rationale,confidence:a.confidence??null,expiresInMinutes:a.expires_in_minutes??120});return result(msg.id,d,'Proposition envoyée dans CHK Crypto. Aucun ordre réel exécuté; confirmation APK obligatoire.');}
 if(name==='list_cancel_proposals'){const d=await bridge({action:'list_cancel_proposals',accountFingerprint,limit:a.limit??40});return result(msg.id,d,`Annulations/remplacements proposés: ${Array.isArray(d?.proposals)?d.proposals.length:0}.`);}
 if(name==='create_cancel_proposal'){const d=await bridge({action:'create_cancel_proposal',accountFingerprint,symbol:a.symbol,targetOrderId:a.target_order_id,targetOrderLinkId:a.target_order_link_id??'',rationale:a.rationale,confidence:a.confidence??null,expiresInMinutes:a.expires_in_minutes??120,replacementSide:a.replacement_side??null,replacementOrderType:a.replacement_order_type??null,replacementQuoteAmountUsdc:a.replacement_quote_amount_usdc??null,replacementBaseQuantity:a.replacement_base_quantity??null,replacementLimitPrice:a.replacement_limit_price??null,replacementRationale:a.replacement_rationale??null,replacementConfidence:a.replacement_confidence??null});return result(msg.id,d,'Proposition d’annulation/remplacement envoyée dans CHK Crypto. Aucune annulation réelle exécutée; confirmation APK obligatoire.');}
 return upstreamRpc(msg);
}
async function proxy(req,res,raw){const target=new URL(req.url,`http://127.0.0.1:${UPSTREAM_PORT}`);const r=await fetch(target,{method:req.method,headers:{...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(req.headers.accept?{accept:req.headers.accept}:{}),...(req.headers['mcp-protocol-version']?{'mcp-protocol-version':req.headers['mcp-protocol-version']}:{})},body:raw});const text=await r.text();res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);}
async function waitForUpstream(){for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('v13_startup_timeout');}
const server=http.createServer(async(req,res)=>{try{const raw=req.method==='GET'||req.method==='HEAD'?undefined:await bodyText(req);const u=new URL(req.url,`https://${req.headers.host}`);if(u.pathname==='/mcp'&&req.method==='POST'){let parsed;try{parsed=JSON.parse(raw||'{}');}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}const out=Array.isArray(parsed)?await Promise.all(parsed.map(handleOne)):await handleOne(parsed);return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});}if(u.pathname==='/health'){let upstream={};try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);upstream=await r.json();}catch{}return json(res,200,{...upstream,gatewayVersion:SERVER_VERSION,mcpBridge:true});}return proxy(req,res,raw);}catch(e){console.error('v14_request_error',e?.message||e);return json(res,500,{error:'server_error',message:String(e?.message||e).slice(0,200)});}});
try{await waitForUpstream();server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto Gateway v${SERVER_VERSION} isolated MCP bridge on :${PORT}`));}catch(e){console.error(e);child.kill('SIGTERM');process.exit(1);}
