import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT=Number(process.env.PORT||3000);
const UPSTREAM_PORT=Number(process.env.V14_UPSTREAM_PORT||(PORT+10));
const SERVER_VERSION='14.5.0';
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
async function bridge(payload){return internalPost(bridgeUrl(),payload,'chk-crypto-workspace-v14.5');}
async function chartBridge(payload){return internalPost(chartUrl(),payload,'chk-crypto-workspace-v14.5-analysis-compat');}
async function upstreamRpc(msg){const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/mcp`,{method:'POST',headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18',accept:'application/json'},body:JSON.stringify(msg)});const text=await r.text();if(!r.ok)throw new Error(`v13 ${r.status}: ${text.slice(0,180)}`);return JSON.parse(text||'{}');}
function result(id,data,text){return{jsonrpc:'2.0',id,result:{content:[{type:'text',text}],structuredContent:data}};}
function parseCompatPayload(content){let p;try{p=JSON.parse(String(content||''));}catch{throw new Error('Pour les modes de compatibilité, content doit être un objet JSON valide.');}if(!p||typeof p!=='object'||Array.isArray(p))throw new Error('Payload de compatibilité invalide');return p;}
const ANALYSIS_FALLBACK={available:true,tool:'create_note',kind:'ANALYSIS_CONTROL',rule:'Si les outils graphiques dédiés ne sont pas visibles, NE PAS répondre que le contrôle est indisponible. Utiliser create_note avec kind=ANALYSIS_CONTROL.',examples:{timeframe:{action:'set_timeframe',timeframe:'15m'},zoom:{action:'zoom_chart',direction:'in'},pan:{action:'pan_candles',direction:'left',candles:50},scroll:{action:'scroll_analysis_view',direction:'down',amount:800},symbol:{action:'set_symbol',symbol:'RENDERUSDC'}}};
const DELEGATED_AUTO_TRADE={available:true,directMcpTrading:false,mode:'proposal_to_apk_auto_trade',requiredApkVersion:'0.9.7+',flow:'ChatGPT/MCP create_trade_proposal -> CHK Crypto pending proposal -> Auto-Trade CHK -> Bybit EU Spot',requirements:['Auto-Trade CHK activé dans l APK','Auto-confirmer les propositions ChatGPT activé','proposition créée après activation Auto-Trade','ordre LIMIT CRYPTO/USDC','montant et plafonds journaliers respectés','clés Bybit SpotTrade présentes dans le stockage chiffré de l APK'],rule:'directMcpTrading=false signifie seulement que le MCP ne possède pas et n utilise pas directement les clés Bybit. Cela NE signifie PAS qu une proposition autorisée par l utilisateur ne peut pas être exécutée automatiquement par CHK Crypto.'};
const DELEGATED_AUTO_CANCEL={available:true,directMcpTrading:false,mode:'cancel_proposal_to_apk_auto_cancel',requiredApkVersion:'0.9.8+',flow:'ChatGPT/MCP create_cancel_proposal -> CHK Crypto pending cancellation -> Auto-Trade CHK -> Bybit EU cancel -> optional replacement proposal -> Auto-Trade CHK',requirements:['Auto-Trade CHK activé dans l APK','Autoriser Bot CHK à annuler/remplacer mes ordres sur demande activé','demande d annulation créée après cette autorisation','Order ID Bybit exact sur une paire Spot CRYPTO/USDC','si remplacement: ordre LIMIT et plafonds Auto-Trade respectés'],rule:'Le MCP ne supprime jamais directement un ordre Bybit. Avec CHK Crypto 0.9.8+ et l autorisation séparée active, une NOUVELLE demande create_cancel_proposal peut être claimée puis exécutée automatiquement par l APK. Un remplacement éventuel n est créé qu après confirmation de l annulation par Bybit.'};
function analysisCommand(p){
 const action=String(p.action||p.op||'').trim().toLowerCase();
 if(!action)throw new Error('action Analyse requise');
 if(action==='set_timeframe'||action==='set_chart_timeframe')return{op:'set_timeframe',args:{timeframe:String(p.timeframe||'').trim().toLowerCase()}};
 if(action==='set_symbol'||action==='set_chart_symbol')return{op:'set_symbol',args:{symbol:String(p.symbol||'').trim().toUpperCase()}};
 if(action==='zoom_chart'||action==='zoom'){const direction=String(p.direction||p.mode||'in').toLowerCase();return{op:direction==='out'||direction==='minus'||direction==='-'?'zoom_out':'zoom_in',args:{}};}
 if(action==='pan_chart'||action==='pan_candles'||action==='pan'){const direction=String(p.direction||'left').toLowerCase();const candles=Math.max(1,Math.min(500,Number(p.candles||p.count||20)));return{op:direction==='right'||direction==='latest'||direction==='forward'?'pan_right':'pan_left',args:{candles}};}
 if(action==='scroll_analysis_view'||action==='scroll_analysis'||action==='scroll'){const args={};if(p.direction!=null)args.direction=String(p.direction).toLowerCase();if(p.amount!=null)args.amount=Math.max(1,Math.min(5000,Number(p.amount)));if(p.position!=null)args.position=String(p.position).toLowerCase();return{op:'scroll_analysis',args};}
 if(action==='set_indicator'||action==='set_indicators'){const src=p.indicators&&typeof p.indicators==='object'?p.indicators:p;const args={};for(const k of ['ma','ema','volume','bollinger','rsi','macd','atr'])if(src[k]!==undefined)args[k]=src[k];return{op:'set_indicators',args};}
 if(action==='set_visible_range'){const args={};if(p.visible_count!=null)args.visible_count=Math.max(12,Math.min(600,Number(p.visible_count)));if(p.offset_from_end!=null)args.offset_from_end=Math.max(0,Number(p.offset_from_end));return{op:'set_visible_range',args};}
 if(action==='set_auto_scale'||action==='auto_scale')return{op:'set_auto_scale',args:{enabled:p.enabled!==false}};
 if(action==='go_to_latest'||action==='latest')return{op:'go_to_latest',args:{}};
 if(action==='reset_view'||action==='reset_chart')return{op:'reset_view',args:{}};
 throw new Error(`Action Analyse non supportée: ${action}`);
}
async function enqueueAnalysis(accountFingerprint,command){
 const state=await chartBridge({action:'get_state',accountFingerprint});
 if(Number(state?.command_seq||0)>Number(state?.applied_seq||0)){
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
function appendCompatHints(out){
 if(!out?.result)return out;
 const sc=out.result.structuredContent&&typeof out.result.structuredContent==='object'?out.result.structuredContent:{};
 out.result.structuredContent={...sc,analysisControlFallback:ANALYSIS_FALLBACK,delegatedAutoTrade:DELEGATED_AUTO_TRADE,delegatedAutoCancel:DELEGATED_AUTO_CANCEL};
 const content=Array.isArray(out.result.content)?out.result.content:[];
 const analysisText='IMPORTANT CHK Crypto : le contrôle de l onglet Analyse EST disponible même si les nouveaux outils sont masqués par le cache. Utilise create_note avec kind=ANALYSIS_CONTROL et content JSON (set_timeframe, zoom_chart, pan_candles, scroll_analysis_view, set_indicator). Ne réponds pas que le contrôle est indisponible.';
 const autoText='IMPORTANT AUTO-TRADE CHK : directMcpTrading=false signifie uniquement que le MCP ne trade pas directement sur Bybit. Avec CHK Crypto 0.9.7+, si Auto-Trade et Auto-confirmer les propositions ChatGPT sont activés, une NOUVELLE proposition LIMIT créée via create_trade_proposal peut être exécutée automatiquement par l APK sans deuxième clic, sous les plafonds configurés. Ne réponds pas que l automatisation est impossible uniquement à cause de directMcpTrading=false.';
 const cancelText='IMPORTANT AUTO-ANNULATION CHK : avec CHK Crypto 0.9.8+, si Auto-Trade et Autoriser Bot CHK à annuler/remplacer mes ordres sur demande sont activés, une NOUVELLE create_cancel_proposal visant un Order ID précis peut être exécutée automatiquement par l APK. Un remplacement éventuel est créé seulement après annulation Bybit confirmée et reste soumis aux limites LIMIT Auto-Trade.';
 if(!content.some(x=>x?.type==='text'&&String(x.text||'').includes('ANALYSIS_CONTROL')))content.push({type:'text',text:analysisText});
 if(!content.some(x=>x?.type==='text'&&String(x.text||'').includes('AUTO-TRADE CHK')))content.push({type:'text',text:autoText});
 if(!content.some(x=>x?.type==='text'&&String(x.text||'').includes('AUTO-ANNULATION CHK')))content.push({type:'text',text:cancelText});
 out.result.content=content;
 return out;
}
function patchToolDescriptions(out){
 const tools=Array.isArray(out?.result?.tools)?out.result.tools:[];
 const trade=tools.find(t=>t?.name==='create_trade_proposal');
 if(trade)trade.description='Crée une proposition BUY/SELL CHK Crypto. Le MCP ne trade pas directement sur Bybit. Avec CHK Crypto 0.9.7+ et Auto-Trade + auto-confirmation ChatGPT activés, une nouvelle proposition LIMIT éligible peut être exécutée automatiquement par l APK sans deuxième clic.';
 const cancel=tools.find(t=>t?.name==='create_cancel_proposal');
 if(cancel)cancel.description='Crée une demande d annulation ou annulation+remplacement d un ordre Bybit précis. Avec CHK Crypto 0.9.8+ et l autorisation séparée annuler/remplacer activée, une nouvelle demande peut être exécutée automatiquement par l APK; le remplacement éventuel est créé uniquement après annulation Bybit confirmée et reste soumis aux limites Auto-Trade LIMIT.';
 return out;
}
const passthroughWithHint=new Set(['get_workspace_info','get_bybit_market_snapshot','get_latest_snapshot']);
const handled=new Set(['create_note','list_notes','create_trade_proposal','list_trade_proposals','create_cancel_proposal','list_cancel_proposals',...passthroughWithHint]);
async function handleOne(msg){
 if(msg?.method==='initialize'){const out=await upstreamRpc(msg);if(out?.result){out.result.serverInfo={name:'chk-crypto-workspace',version:SERVER_VERSION};out.result.instructions='CHK Crypto v14.5. IMPORTANT cache: contrôle Analyse via create_note kind=ANALYSIS_CONTROL si nécessaire. AUTO-TRADE DÉLÉGUÉ: directMcpTrading=false ne signifie pas automatisation impossible. Sur CHK Crypto 0.9.7+, une nouvelle create_trade_proposal LIMIT peut être auto-exécutée si Auto-Trade + auto-confirmation ChatGPT sont autorisés. Sur CHK Crypto 0.9.8+, une nouvelle create_cancel_proposal peut également être auto-exécutée si l autorisation séparée annuler/remplacer est active. Une annulation cible un Order ID précis; un remplacement n est créé qu après annulation Bybit confirmée et reste soumis aux plafonds Auto-Trade. Les propositions antérieures aux autorisations ne sont jamais auto-exécutées.';}return out;}
 if(msg?.method==='tools/list')return patchToolDescriptions(await upstreamRpc(msg));
 if(msg?.method!=='tools/call') return upstreamRpc(msg);
 const name=String(msg?.params?.name||'');if(!handled.has(name)) return upstreamRpc(msg);
 if(passthroughWithHint.has(name))return appendCompatHints(await upstreamRpc(msg));
 const a=msg?.params?.arguments||{};const accountFingerprint=sha256(BYBIT_API_KEY);
 if(name==='list_notes'){
  const [notes,alerts]=await Promise.all([bridge({action:'list_notes',accountFingerprint,limit:a.limit??100}),bridge({action:'list_alerts',accountFingerprint,limit:a.limit??100})]);
  const d={...notes,alerts:Array.isArray(alerts?.alerts)?alerts.alerts:[],alarmCompatibility:true,analysisControlCompatibility:true,analysisControlFallback:ANALYSIS_FALLBACK,delegatedAutoTrade:DELEGATED_AUTO_TRADE,delegatedAutoCancel:DELEGATED_AUTO_CANCEL};
  return result(msg.id,d,`Bloc-notes CHK Crypto: ${Array.isArray(notes?.notes)?notes.notes.length:0} note(s) • ${d.alerts.length} alarme(s). Auto-Trade délégué disponible via create_trade_proposal; en CHK Crypto 0.9.8+, annulation/remplacement délégué disponible via create_cancel_proposal si l autorisation séparée est active.`);
 }
 if(name==='create_note'){
  const kind=String(a.kind??'ANALYSIS').trim().toUpperCase();
  if(kind==='ANALYSIS_CONTROL'||kind==='CHART_CONTROL'){const p=parseCompatPayload(a.content);const command=analysisCommand(p);const d=await enqueueAnalysis(accountFingerprint,command);return result(msg.id,d,`Commande Analyse envoyée à l APK via compatibilité create_note: ${command.op}.`);}
  if(kind==='ALERT'||kind==='ALERT_CREATE'){const p=parseCompatPayload(a.content);const d=await bridge({action:'create_alert',accountFingerprint,symbol:p.symbol,condition:p.condition,targetPrice:p.target_price??p.targetPrice,label:p.label??'',rationale:p.rationale??'',oneShot:p.one_shot??p.oneShot??true,enabled:p.enabled!==false});return result(msg.id,d,d?.duplicate?'Alarme déjà présente dans CHK Crypto.':'Alarme créée dans CHK Crypto via compatibilité create_note.');}
  if(kind==='ALERT_UPDATE'){const p=parseCompatPayload(a.content);const d=await bridge({action:'update_alert',accountFingerprint,id:p.id,condition:p.condition,targetPrice:p.target_price??p.targetPrice,label:p.label,rationale:p.rationale,enabled:p.enabled,oneShot:p.one_shot??p.oneShot});return result(msg.id,d,'Alarme CHK Crypto mise à jour via compatibilité create_note.');}
  if(kind==='ALERT_DELETE'){const p=parseCompatPayload(a.content);const d=await bridge({action:'delete_alert',accountFingerprint,id:p.id});return result(msg.id,d,'Alarme CHK Crypto supprimée via compatibilité create_note.');}
  const d=await bridge({action:'create_note',accountFingerprint,content:a.content,exchange:a.exchange??'GLOBAL',kind});return result(msg.id,d,'Note enregistrée dans CHK Crypto.');
 }
 if(name==='list_trade_proposals'){const d=await bridge({action:'list_trade_proposals',accountFingerprint,limit:a.limit??40});return result(msg.id,{...d,delegatedAutoTrade:DELEGATED_AUTO_TRADE},`Propositions CHK Crypto: ${Array.isArray(d?.proposals)?d.proposals.length:0}. directMcpTrading=false n empêche pas l APK 0.9.7+ d auto-exécuter une nouvelle proposition LIMIT si Auto-Trade + auto-confirmation ChatGPT sont activés.`);}
 if(name==='create_trade_proposal'){const d=await bridge({action:'create_trade_proposal',accountFingerprint,symbol:a.symbol,side:a.side,orderType:a.order_type,quoteAmountUsdc:a.quote_amount_usdc,baseQuantity:a.base_quantity??null,limitPrice:a.limit_price??null,rationale:a.rationale,confidence:a.confidence??null,expiresInMinutes:a.expires_in_minutes??120});return result(msg.id,{...d,delegatedAutoTrade:DELEGATED_AUTO_TRADE},'Proposition envoyée dans CHK Crypto. Le MCP ne trade pas directement sur Bybit. Si CHK Crypto 0.9.7+ a Auto-Trade + Auto-confirmer les propositions ChatGPT activés et que cette NOUVELLE proposition LIMIT respecte les plafonds, l APK peut l exécuter automatiquement sans deuxième clic; sinon elle reste en attente de confirmation.');}
 if(name==='list_cancel_proposals'){const d=await bridge({action:'list_cancel_proposals',accountFingerprint,limit:a.limit??40});return result(msg.id,{...d,delegatedAutoCancel:DELEGATED_AUTO_CANCEL},`Annulations/remplacements proposés: ${Array.isArray(d?.proposals)?d.proposals.length:0}. Avec CHK Crypto 0.9.8+ et l autorisation annuler/remplacer active, une nouvelle demande éligible peut être exécutée automatiquement par l APK.`);}
 if(name==='create_cancel_proposal'){const d=await bridge({action:'create_cancel_proposal',accountFingerprint,symbol:a.symbol,targetOrderId:a.target_order_id,targetOrderLinkId:a.target_order_link_id??'',rationale:a.rationale,confidence:a.confidence??null,expiresInMinutes:a.expires_in_minutes??120,replacementSide:a.replacement_side??null,replacementOrderType:a.replacement_order_type??null,replacementQuoteAmountUsdc:a.replacement_quote_amount_usdc??null,replacementBaseQuantity:a.replacement_base_quantity??null,replacementLimitPrice:a.replacement_limit_price??null,replacementRationale:a.replacement_rationale??null,replacementConfidence:a.replacement_confidence??null});return result(msg.id,{...d,delegatedAutoCancel:DELEGATED_AUTO_CANCEL},'Demande d annulation/remplacement envoyée dans CHK Crypto. Le MCP n annule pas directement sur Bybit. Si CHK Crypto 0.9.8+ a Auto-Trade + Autoriser Bot CHK à annuler/remplacer mes ordres sur demande activés et que cette NOUVELLE demande cible un Order ID valide, l APK peut l exécuter automatiquement sans deuxième clic. Un remplacement éventuel est créé seulement après annulation Bybit confirmée et reste soumis aux limites Auto-Trade LIMIT; sinon la demande reste en attente de confirmation.');}
 return upstreamRpc(msg);
}
async function proxy(req,res,raw){const target=new URL(req.url,`http://127.0.0.1:${UPSTREAM_PORT}`);const r=await fetch(target,{method:req.method,headers:{...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(req.headers.accept?{accept:req.headers.accept}:{}),...(req.headers['mcp-protocol-version']?{'mcp-protocol-version':req.headers['mcp-protocol-version']}:{})},body:raw});const text=await r.text();res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);}
async function waitForUpstream(){for(let i=0;i<100;i++){try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('v13_startup_timeout');}
const server=http.createServer(async(req,res)=>{try{const raw=req.method==='GET'||req.method==='HEAD'?undefined:await bodyText(req);const u=new URL(req.url,`https://${req.headers.host}`);if(u.pathname==='/mcp'&&req.method==='POST'){let parsed;try{parsed=JSON.parse(raw||'{}');}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}const out=Array.isArray(parsed)?await Promise.all(parsed.map(handleOne)):await handleOne(parsed);return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});}if(u.pathname==='/health'){let upstream={};try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);upstream=await r.json();}catch{}return json(res,200,{...upstream,gatewayVersion:SERVER_VERSION,mcpBridge:true,alarmCompatibilityViaNotes:true,analysisControlViaNotes:true,analysisFallbackAdvertisedOnCachedReads:true,directMcpTrading:false,delegatedAutoTrade:true,autoTradeViaProposal:true,delegatedAutoTradeInfo:DELEGATED_AUTO_TRADE,delegatedAutoCancel:true,autoCancelViaProposal:true,delegatedAutoCancelInfo:DELEGATED_AUTO_CANCEL});}return proxy(req,res,raw);}catch(e){console.error('v14_request_error',e?.message||e);return json(res,500,{error:'server_error',message:String(e?.message||e).slice(0,240)});}});
try{await waitForUpstream();server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto Gateway v${SERVER_VERSION} Analyse + delegated Auto-Trade + Auto-Cancel on :${PORT}`));}catch(e){console.error(e);child.kill('SIGTERM');process.exit(1);}
