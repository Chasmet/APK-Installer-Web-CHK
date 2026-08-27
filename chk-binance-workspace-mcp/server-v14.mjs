import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT=Number(process.env.PORT||3000);
const UPSTREAM_PORT=Number(process.env.V14_UPSTREAM_PORT||(PORT+10));
const SERVER_VERSION='14.2.0';
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
function edgeUrl(slug){const u=new URL(EDGE_URL);u.pathname=u.pathname.replace(/\/chk-binance-workspace-latest\/?$/,`/${slug}`);return u.toString();}
function bridgeUrl(){return edgeUrl('chk-mcp-bridge');}
function chartUrl(){return edgeUrl('chk-chart-control');}
async function internalPost(url,payload,userAgent){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-chk-internal-token':CHK_INTERNAL_TOKEN,accept:'application/json','user-agent':userAgent},body:JSON.stringify(payload)});const text=await r.text();let data;try{data=JSON.parse(text||'{}');}catch{data={raw:text};}if(!r.ok)throw new Error(`${new URL(url).pathname.split('/').pop()} ${r.status}: ${data?.error||data?.message||text.slice(0,180)}`);return data;}
async function bridge(payload){return internalPost(bridgeUrl(),payload,'chk-crypto-workspace-v14.2');}
async function chartBridge(payload){return internalPost(chartUrl(),payload,'chk-crypto-workspace-v14.2-analysis-compat');}
async function upstreamRpc(msg){const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/mcp`,{method:'POST',headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18',accept:'application/json'},body:JSON.stringify(msg)});const text=await r.text();if(!r.ok)throw new Error(`v13 ${r.status}: ${text.slice(0,180)}`);return JSON.parse(text||'{}');}
function result(id,data,text){return{jsonrpc:'2.0',id,result:{content:[{type:'text',text}],structuredContent:data}};}
function parseCompatPayload(content){let p;try{p=JSON.parse(String(content||''));}catch{throw new Error('Pour les modes de compatibilité, content doit être un objet JSON valide.');}if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('Payload de compatibilité invalide');return p;}
function analysisCommand(p){
 const action=String(p.action||p.op||'').trim().toLowerCase();
 if(!action)throw new Error('action Analyse requise');
 if(action==='set_timeframe'||action==='set_chart_timeframe')return{op:'set_timeframe',args:{timeframe:String(p.timeframe||'').trim().toLowerCase()}};
 if(action==='set_symbol'||action==='set_chart_symbol')return{op:'set_symbol',args:{symbol:String(p.symbol||'').trim().toUpperCase()}};
 if(action==='zoom_chart'||action==='zoom'){
  const direction=String(p.direction||p.mode||'in').toLowerCase();
  return{op:direction==='out'||direction==='minus'||direction==='-'?'zoom_out':'zoom_in',args:{}};
 }
 if(action==='pan_chart'||action==='pan_candles'||action==='pan'){
  const direction=String(p.direction||'left').toLowerCase();
  const candles=Math.max(1,Math.min(500,Number(p.candles||p.count||20)));
  return{op:direction==='right'||direction==='latest'||direction==='forward'?'pan_right':'pan_left',args:{candles}};
 }
 if(action==='scroll_analysis_view'||action==='scroll_analysis'||action==='scroll'){
  const args={};
  if(p.direction!=null)args.direction=String(p.direction).toLowerCase();
  if(p.amount!=null)args.amount=Math.max(1,Math.min(5000,Number(p.amount)));
  if(p.position!=null)args.position=String(p.position).toLowerCase();
  return{op:'scroll_analysis',args};
 }
 if(action==='set_indicator'||action==='set_indicators'){
  const src=p.indicators&&typeof p.indicators==='object'?p.indicators:p;
  const args={};for(const k of ['ma','ema','volume','bollinger','rsi','macd','atr'])if(src[k]!==undefined)args[k]=src[k];
  return{op:'set_indicators',args};
 }
 if(action==='set_visible_range'){
  const args={};if(p.visible_count!=null)args.visible_count=Math.max(12,Math.min(600,Number(p.visible_count)));if(p.offset_from_end!=null)args.offset_from_end=Math.max(0,Number(p.offset_from_end));return{op:'set_visible_range',args};
 }
 if(action==='set_auto_scale'||action==='auto_scale')return{op:'set_auto_scale',args:{enabled:p.enabled!==false}};
 if(action==='go_to_latest'||action==='latest')return{op:'go_to_latest',args:{}};
 if(action==='reset_view'||action==='reset_chart')return{op:'reset_view',args:{}};
 throw new Error(`Action Analyse non supportée: ${action}`);
}
async function enqueueAnalysis(accountFingerprint,command){
 const state=await chartBridge({action:'get_state',accountFingerprint});
 const pending=Number(state?.command_seq||0)>Number(state?.applied_seq||0);
 if(pending){
  for(let i=0;i<12;i++){
   await new Promise(r=>setTimeout(r,250));
   const s=await chartBridge({action:'get_state',accountFingerprint});
   if(Number(s?.command_seq||0)<=Number(s?.applied_seq||0))break;
   if(i===11)throw new Error('Une commande graphique précédente est encore en attente dans l APK. Ouvre l onglet Analyse puis réessaie.');
  }
 }
 const queued=await chartBridge({action:'enqueue_command',accountFingerprint,command});
 return{...queued,compatibility:'create_note/ANALYSIS_CONTROL'};
}
const handled=new Set(['create_note','list_notes','create_trade_proposal','list_trade_proposals','create_cancel_proposal','list_cancel_proposals']);
async function handleOne(msg){
 if(msg?.method==='initialize'){const out=await upstreamRpc(msg);if(out?.result){out.result.serverInfo={name:'chk-crypto-workspace',version:SERVER_VERSION};out.result.instructions='CHK Crypto v14.2. Compatibilité cache: alarmes via create_note kind=ALERT. Contrôle Analyse même si les nouveaux outils MCP ne sont pas visibles: utiliser create_note kind=ANALYSIS_CONTROL avec content JSON. Actions acceptées: set_timeframe, set_symbol, zoom_chart, pan_chart/pan_candles, set_indicator, scroll_analysis_view, set_visible_range, set_auto_scale, go_to_latest, reset_view. Exemple content={"action":"set_timeframe","timeframe":"15m"}. Les commandes pilotent le vrai onglet Analyse; aucun ordre réel sans confirmation APK.';}return out;}
 if(msg?.method!=='tools/call') return upstreamRpc(msg);
 const name=String(msg?.params?.name||'');if(!handled.has(name)) return upstreamRpc(msg);
 const a=msg?.params?.arguments||{};const accountFingerprint=sha256(BYBIT_API_KEY);
 if(name==='list_notes'){
  const [notes,alerts]=await Promise.all([bridge({action:'list_notes',accountFingerprint,limit:a.limit??100}),bridge({action:'list_alerts',accountFingerprint,limit:a.limit??100})]);
  const d={...notes,alerts:Array.isArray(alerts?.alerts)?alerts.alerts:[],alarmCompatibility:true,analysisControlCompatibility:true};
  return result(msg.id,d,`Bloc-notes CHK Crypto: ${Array.isArray(notes?.notes)?notes.notes.length:0} note(s) • ${d.alerts.length} alarme(s) • contrôle Analyse compatible ancien catalogue.`);
 }
 if(name==='create_note'){
  const kind=String(a.kind??'ANALYSIS').trim().toUpperCase();
  if(kind==='ANALYSIS_CONTROL'||kind==='CHART_CONTROL'){
   const p=parseCompatPayload(a.content);const command=analysisCommand(p);const d=await enqueueAnalysis(accountFingerprint,command);
   return result(msg.id,d,`Commande Analyse envoyée à l APK via compatibilité create_note: ${command.op}.`);
  }
  if(kind==='ALERT'||kind==='ALERT_CREATE'){
   const p=parseCompatPayload(a.content);const d=await bridge({action:'create_alert',accountFingerprint,symbol:p.symbol,condition:p.condition,targetPrice:p.target_price??p.targetPrice,label:p.label??'',rationale:p.rationale??'',oneShot:p.one_shot??p.oneShot??true,enabled:p.enabled!==false});
   return result(msg.id,d,d?.duplicate?'Alarme déjà présente dans CHK Crypto.':'Alarme créée dans CHK Crypto via compatibilité create_note.');
  }
  if(kind==='ALERT_UPDATE'){
   const p=parseCompatPayload(a.content);const d=await bridge({action:'update_alert',accountFingerprint,id:p.id,condition:p.condition,targetPrice:p.target_price??p.targetPrice,label:p.label,rationale:p.rationale,enabled:p.enabled,oneShot:p.one_shot??p.oneShot});
   return result(msg.id,d,'Alarme CHK Crypto mise à jour via compatibilité create_note.');
  }
  if(kind==='ALERT_DELETE'){
   const p=parseCompatPayload(a.content);const d=await bridge({action:'delete_alert',accountFingerprint,id:p.id});
   return result(msg.id,d,'Alarme CHK Crypto supprimée via compatibilité create_note.');
  }
  const d=await bridge({action:'create_note',accountFingerprint,content:a.content,exchange:a.exchange??'GLOBAL',kind});return result(msg.id,d,'Note enregistrée dans CHK Crypto.');
 }
 if(name==='list_trade_proposals'){const d=await bridge({action:'list_trade_proposals',accountFingerprint,limit:a.limit??40});return result(msg.id,d,`Propositions CHK Crypto: ${Array.isArray(d?.proposals)?d.proposals.length:0}.`);}
 if(name==='create_trade_proposal'){const d=await bridge({action:'create_trade_proposal',accountFingerprint,symbol:a.symbol,side:a.side,orderType:a.order_type,quoteAmountUsdc:a.quote_amount_usdc,baseQuantity:a.base_quantity??null,limitPrice:a.limit_price??null,rationale:a.rationale,confidence:a.confidence??null,expiresInMinutes:a.expires_in_minutes??120});return result(msg.id,d,'Proposition envoyée dans CHK Crypto. Aucun ordre réel exécuté; confirmation APK obligatoire.');}
 if(name==='list_cancel_proposals'){const d=await bridge({action:'list_cancel_proposals',accountFingerprint,limit:a.limit??40});return result(msg.id,d,`Annulations/remplacements proposés: ${Array.isArray(d?.proposals)?d.proposals.length:0}.`);}
 if(name==='create_cancel_proposal'){const d=await bridge({action:'create_cancel_proposal',accountFingerprint,symbol:a.symbol,targetOrderId:a.target_order_id,targetOrderLinkId:a.target_order_link_id??'',rationale:a.rationale,confidence:a.confidence??null,expiresInMinutes:a.expires_in_minutes??120,replacementSide:a.replacement_side??null,replacementOrderType:a.replacement_order_type??null,replacementQuoteAmountUsdc:a.replacement_quote_amount_usdc??null,replacementBaseQuantity:a.replacement_base_quantity??null,replacementLimitPrice:a.replacement_limit_price??null,replacementRationale:a.replacement_rationale??null,replacementConfidence:a.replacement_confidence??null});return result(msg.id,d,'Proposition d’annulation/remplacement envoyée dans CHK Crypto. Aucune annulation réelle exécutée; confirmation APK obligatoire.');}
 return upstreamRpc(msg);
}
async function proxy(req,res,raw){const target=new URL(req.url,`http://127.0.0.1:${UPSTREAM_PORT}`);const r=await fetch(target,{method:req.method,headers:{...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(req.headers.accept?{accept:req.headers.accept}:{}),...(req.headers['mcp-protocol-version']?{'mcp-protocol-version':req.headers['mcp-protocol-version']}:{})},body:raw});const text=await r.text();res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);}
async function waitForUpstream(){for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('v13_startup_timeout');}
const server=http.createServer(async(req,res)=>{try{const raw=req.method==='GET'||req.method==='HEAD'?undefined:await bodyText(req);const u=new URL(req.url,`https://${req.headers.host}`);if(u.pathname==='/mcp'&&req.method==='POST'){let parsed;try{parsed=JSON.parse(raw||'{}');}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}const out=Array.isArray(parsed)?await Promise.all(parsed.map(handleOne)):await handleOne(parsed);return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});}if(u.pathname==='/health'){let upstream={};try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);upstream=await r.json();}catch{}return json(res,200,{...upstream,gatewayVersion:SERVER_VERSION,mcpBridge:true,alarmCompatibilityViaNotes:true,analysisControlViaNotes:true});}return proxy(req,res,raw);}catch(e){console.error('v14_request_error',e?.message||e);return json(res,500,{error:'server_error',message:String(e?.message||e).slice(0,240)});}});
try{await waitForUpstream();server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto Gateway v${SERVER_VERSION} bridge + alarm + Analyse cache compatibility on :${PORT}`));}catch(e){console.error(e);child.kill('SIGTERM');process.exit(1);}
