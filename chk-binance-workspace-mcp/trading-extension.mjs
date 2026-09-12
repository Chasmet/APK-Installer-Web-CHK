import crypto from 'node:crypto';
import {batchTools,handleBatchTool} from './batch-tools.mjs';
import {MAX_ORDER_USDC,MAX_BATCH_ORDERS,orderLinkId} from './trading-config.mjs';
import {prepareOrders} from './order-splitting.mjs';

export const TRADING_INSTRUCTIONS = `Plafond par ordre ${MAX_ORDER_USDC} USDC. Flux : proposition → bot APK auto-confirm si autorisé → Bybit → vérification par OrderLinkId. Pour plusieurs ordres, envoyer TOUS les éléments dans create_trade_batch avec un batchId UUID stable. Découpage automatique au plafond et au pas Bybit. Après timeout/HTTP 500 : wait_trade_batch avec les mêmes proposalIds, aucun nouvel ordre. reportReady=false : suivi intermédiaire, poursuivre sans demander de répéter la demande. Rapporter chaque état OPEN/PARTIALLY_FILLED/FILLED/REJECTED/FAILED ou le blocage exact. OPEN ne signifie pas FILLED. Budgets quotidiens Android conservés. Catalogue ChatGPT ancien : create_note(kind="TRADE_BATCH",content=JSON.stringify({batchId,orders})) crée le même lot autorisé ; create_note(kind="TRADE_BATCH_STATUS",content=JSON.stringify({proposalIds})) reprend le suivi. Ces kinds ne créent pas de note et TRADE_BATCH peut déclencher Auto-Trade : respecter la demande utilisateur.`;
export function proposalIdsForBatch(account,batchId,count) {
  return Array.from({length:count},(_,i)=>{
    const h=crypto.createHash('sha256').update(`${account}:${batchId}:${i}`).digest('hex').slice(0,32);
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  });
}
const uuid=v=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const reply=(msg,data)=>({jsonrpc:'2.0',id:msg.id,result:data});
const pending=(ids,e)=>({ok:true,allConfirmed:false,reportReady:false,proposalIds:ids,total:ids.length,confirmed:0,pending:ids.length,
  orders:ids.map(id=>({id,orderLinkId:orderLinkId(id),status:'UNKNOWN',confirmed:false,resolved:false})),
  verificationError:String(e?.message||e),retryable:true,nextTool:'wait_trade_batch',nextArguments:{proposalIds:ids}});
export function createTradingExtension({bridge,accountFingerprint='',readOrder=async()=>null,instrument=async()=>({}),now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}) {
  const names=new Set([...batchTools.map(t=>t.name),'create_trade_proposal','list_trade_proposals','create_cancel_proposal']);
  function patchTools(existing) {
    const tools=structuredClone(existing);
    for(const t of tools){
      for(const field of ['quote_amount_usdc','replacement_quote_amount_usdc']){
        const a=t.inputSchema?.properties?.[field];if(a){a.maximum=MAX_ORDER_USDC;a.exclusiveMinimum=1;}
      }
      if(t.name==='create_trade_proposal'){
        t.description='Crée et vérifie un ordre autorisé. request_id UUID stable assure les retries sans doublon. Sans request_id, demandes strictement identiques regroupées pendant dix minutes ; nouveau request_id pour une nouvelle intention identique. '+TRADING_INSTRUCTIONS;
        t.inputSchema.properties.order_type={type:'string',enum:['LIMIT']};
        t.inputSchema.properties.request_id={type:'string',format:'uuid'};
        t.annotations={readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true};
      }
      if(t.name==='create_cancel_proposal')t.description=`Annulation d’un Order ID précis. Le bot APK auto-confirme si annuler/remplacer est autorisé. Remplacement <=${MAX_ORDER_USDC} USDC uniquement après annulation Bybit confirmée, sous les limites Android.`;
      if(t.name==='create_note')t.description+=' Kinds TRADE_BATCH et TRADE_BATCH_STATUS, content JSON : création de propositions pouvant être auto-exécutées ou suivi. '+TRADING_INSTRUCTIONS;
      if(t.name==='list_trade_proposals')t.description='Liste et réconcilie les processing par OrderLinkId sur Bybit. '+TRADING_INSTRUCTIONS;
    }
    return [...batchTools,...tools.filter(t=>!batchTools.some(b=>b.name===t.name))];
  }
  async function wait(args) {
    const ids=args.proposalIds;
    if(!Array.isArray(ids)||!ids.length||ids.length>MAX_BATCH_ORDERS||new Set(ids).size!==ids.length||ids.some(id=>!uuid(id)))throw new Error('invalid_proposal_ids');
    const deadline=Math.min(args.deadline??Infinity,now()+Math.min(18000,Math.max(0,Number(args.timeoutMs??18000))));
    const ioDeadline=args.deadline??deadline+1000;
    let data;
    do{
      try{
        data=await bridge({action:'wait_trade_batch',proposalIds:ids,timeoutMs:0},{deadline:ioDeadline});
        const unverified=new Map();
        for(const o of data.orders||[]){
          if(!['processing','executed'].includes(o.proposalStatus)||o.status==='FILLED')continue;
          if(now()>=deadline){if(o.proposalStatus==='executed')unverified.set(o.id,'Délai de vérification atteint.');continue;}
          try{const observed=await readOrder(o,{deadline});if(observed)await bridge({action:'reconcile_trade_result',id:o.id,observed},{deadline:ioDeadline});else if(o.proposalStatus==='executed')unverified.set(o.id,'OrderLinkId non retrouvé ; état actuel à vérifier.');}
          catch(e){unverified.set(o.id,String(e.message||e));}
        }
        data={...data,...await bridge({action:'wait_trade_batch',proposalIds:ids,timeoutMs:0},{deadline:ioDeadline}),proposalIds:ids};
        if(unverified.size){
          data.orders=data.orders.map(o=>unverified.has(o.id)?{...o,lastKnownStatus:o.status,status:'UNKNOWN',resolved:false,confirmed:false,verificationError:unverified.get(o.id)}:o);
          data.allConfirmed=false;data.reportReady=false;data.pending=data.orders.filter(o=>!o.resolved).length;
          data.verificationWarning='Lecture Bybit indisponible : état actuel à vérifier, aucun nouvel envoi.';
        }
        if(data.reportReady||data.allConfirmed||data.pending===0||now()>=deadline)break;
      }catch(e){data=pending(ids,e);if(now()>=deadline)break;}
      await sleep(Math.min(750,Math.max(0,deadline-now())));
    }while(now()<deadline);
    return {...data,proposalIds:ids,nextTool:data.reportReady?null:'wait_trade_batch',nextArguments:data.reportReady?null:{proposalIds:ids}};
  }
  async function create(args) {
    if(!uuid(args.batchId))throw new Error('invalid_batch_id');
    const deadline=now()+18000;
    const orders=await prepareOrders(args.orders,async symbol=>{
      if(now()>=deadline)throw new Error('instrument_deadline_exceeded');
      return instrument(symbol,{deadline});
    });
    const ids=proposalIdsForBatch(accountFingerprint,args.batchId,orders.length);
    let saved;
    try{saved=await bridge({action:'create_trade_batch',batchId:args.batchId,orders},{deadline});}
    catch(e){if(e.retryable===false)throw e;return {...pending(ids,e),batchId:args.batchId,creationUncertain:true,retryBatch:{batchId:args.batchId,orders}};}
    return {...saved,...await wait({proposalIds:saved.proposalIds||ids,timeoutMs:args.timeoutMs,deadline}),batchId:args.batchId,expandedOrderCount:orders.length};
  }
  async function handle(msg,name,args) {
    try{
      if(name==='create_note'){const parsed=JSON.parse(args.content||'{}');name=args.kind==='TRADE_BATCH'?'create_trade_batch':'wait_trade_batch';args=parsed;}
      if(name==='list_trade_proposals'){
        const deadline=now()+18000;
        const data=await bridge({action:'list_trade_proposals',limit:args.limit??100},{deadline});
        const ids=(data.proposals||[]).filter(p=>p.status==='processing').slice(0,20).map(p=>p.id);
        const verification=ids.length?await wait({proposalIds:ids,timeoutMs:12000,deadline}):null;
        const refreshed=verification&&now()<deadline?await bridge({action:'list_trade_proposals',limit:args.limit??100},{deadline}):data;
        const sc={...refreshed,verification};return reply(msg,{structuredContent:sc,content:[{type:'text',text:TRADING_INSTRUCTIONS+'\n'+JSON.stringify(sc)}]});
      }
      if(name==='create_cancel_proposal'){
        const amount=args.replacement_quote_amount_usdc;
        if(amount!=null&&(!Number.isFinite(Number(amount))||Number(amount)<=1||Number(amount)>MAX_ORDER_USDC))throw new Error('invalid_replacement_amount');
        try{
          const data=await bridge({action:'create_cancel_proposal',symbol:args.symbol,targetOrderId:args.target_order_id,
            targetOrderLinkId:args.target_order_link_id??'',rationale:args.rationale,confidence:args.confidence,
            expiresInMinutes:args.expires_in_minutes,replacementSide:args.replacement_side,replacementOrderType:args.replacement_order_type,
            replacementQuoteAmountUsdc:amount,replacementBaseQuantity:args.replacement_base_quantity,replacementLimitPrice:args.replacement_limit_price,
            replacementRationale:args.replacement_rationale,replacementConfidence:args.replacement_confidence});
          return reply(msg,{structuredContent:data,content:[{type:'text',text:'Demande transmise au bot APK, sous les autorisations annuler/remplacer. Vérifier list_cancel_proposals ; ne pas annoncer l’annulation avant preuve Bybit.\n'+JSON.stringify(data)}]});
        }catch(e){return reply(msg,{isError:true,structuredContent:{ok:false,creationUncertain:true,targetOrderId:args.target_order_id,nextTool:'list_cancel_proposals'},content:[{type:'text',text:'Réponse indisponible : vérifier list_cancel_proposals pour cet Order ID avant toute nouvelle demande. '+String(e.message||e)}]});}
      }
      if(name==='create_trade_proposal'){
        const amount=Number(args.quote_amount_usdc);
        if(!Number.isFinite(amount)||amount<=1||amount>MAX_ORDER_USDC)throw new Error(`Montant requis : >1 et <=${MAX_ORDER_USDC} USDC`);
        let batchId=args.request_id;
        if(!batchId){
          const h=crypto.createHash('sha256').update(JSON.stringify([accountFingerprint,args.symbol,args.side,args.order_type,Number(args.quote_amount_usdc),args.base_quantity??null,args.limit_price??null,args.rationale??'',Math.floor(now()/600000)])).digest('hex').slice(0,32);
          batchId=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
        }
        args={batchId,orders:[{symbol:args.symbol,side:args.side,orderType:args.order_type,quoteAmountUsdc:amount,
          baseQuantity:args.base_quantity??null,limitPrice:args.limit_price,rationale:args.rationale}]};name='create_trade_batch';
      }
      return reply(msg,await handleBatchTool(name,args,p=>name==='create_trade_batch'?create(p):wait(p)));
    }catch(e){return reply(msg,{isError:true,structuredContent:{ok:false,error:String(e.message||e),retryable:false},content:[{type:'text',text:String(e.message||e)}]});}
  }
  return {names,patchTools,handle,isCompatibilityCall:(name,args)=>name==='create_note'&&['TRADE_BATCH','TRADE_BATCH_STATUS'].includes(args.kind)};
}
export function createTradeBridge({edgeUrl,token,accountFingerprint,fetchImpl=fetch}) {
  const url=new URL(edgeUrl);url.pathname=url.pathname.replace(/\/chk-binance-workspace-latest\/?$/, '/chk-mcp-bridge');
  return async (payload,{deadline=Infinity}={})=>{
    for(let attempt=0;;attempt++){
      try{
        const remaining=deadline-Date.now();
        if(remaining<=0)throw new Error('trade_bridge_deadline_exceeded');
        const r=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','x-chk-internal-token':token},
          body:JSON.stringify({...payload,accountFingerprint}),signal:AbortSignal.timeout(Math.max(1,Math.min(6000,Math.floor(remaining))))});
        const data=await r.json();
        if(!r.ok){const e=new Error(`Trade bridge HTTP ${r.status}: ${data.error||data.message||'erreur'}`);e.retryable=r.status>=500||r.status===429;throw e;}
        return data;
      }catch(e){const safe=['wait_trade_batch','list_trade_proposals','reconcile_trade_result','create_trade_batch'].includes(payload.action);
        if(attempt>=1||!safe||e.retryable===false||deadline-Date.now()<=250)throw e;await new Promise(r=>setTimeout(r,250));}
    }
  };
}
