import {batchTools, handleBatchTool} from './batch-tools.mjs';

export const TRADING_INSTRUCTIONS = 'Ordres multiples : préparer TOUS les ordres autorisés avec create_trade_batch (maximum 20), puis utiliser wait_trade_batch avec les mêmes proposalIds jusqu’à confirmation de chacun ou motif de blocage. Ne pas terminer après le premier ordre et ne jamais recréer un lot pour le relancer. allConfirmed=true signifie tous les placements Bybit vérifiés ; placé ne signifie pas rempli. Plafond par ordre 30 USDC, budgets quotidiens Android conservés. L’APK exécute les nouvelles propositions LIMIT si Auto-Trade et auto-confirmation ChatGPT sont autorisés. Si les nouveaux outils ne sont pas encore visibles, créer toutes les propositions via create_trade_proposal puis vérifier chaque ID via list_trade_proposals.';

export function createTradingExtension({bridge}) {
  const names = new Set([...batchTools.map(t=>t.name),'create_trade_proposal','list_trade_proposals']);
  function patchTools(tools) {
    for (const tool of tools) {
      if (tool.name === 'create_trade_proposal') {
        const amount = tool.inputSchema?.properties?.quote_amount_usdc;
        if (amount) {amount.maximum=30;amount.exclusiveMinimum=1;}
        tool.description = 'Crée une proposition puis attend sa confirmation Android/Bybit. Pour plusieurs ordres, utiliser create_trade_batch. Si allConfirmed=false, continuer la vérification sans recréer cet ordre. '+TRADING_INSTRUCTIONS;
      }
      if (tool.name === 'create_cancel_proposal') {
        const amount = tool.inputSchema?.properties?.replacement_quote_amount_usdc;
        if (amount) {amount.maximum=30;amount.exclusiveMinimum=1;}
      }
      if (tool.name === 'list_trade_proposals') tool.description += ' Vérifier tous les IDs demandés : exécuté avec bybit_order_id et état Bybit New/PartiallyFilled/Filled. Signaler les motifs result.reason, les processing et les manquants ; ne pas annoncer le succès d’un lot incomplet.';
    }
    for(const tool of batchTools)if(!tools.some(t=>t.name===tool.name))tools.push(tool);
    return tools;
  }
  async function handle(msg,name,args) {
    try {
      if(batchTools.some(t=>t.name===name))return {jsonrpc:'2.0',id:msg.id,result:await handleBatchTool(name,args,bridge)};
      if(name==='list_trade_proposals'){
        const data=await bridge({action:'list_trade_proposals',limit:args.limit??100});
        return {jsonrpc:'2.0',id:msg.id,result:{structuredContent:data,content:[{type:'text',text:TRADING_INSTRUCTIONS}]}};
      }
      const amount=Number(args.quote_amount_usdc);
      if(!Number.isFinite(amount)||amount<=1||amount>30)throw new Error('Montant requis : >1 et <=30 USDC');
      const data=await bridge({action:'create_trade_proposal',symbol:args.symbol,side:args.side,orderType:args.order_type,
        quoteAmountUsdc:amount,baseQuantity:args.base_quantity??null,limitPrice:args.limit_price??null,
        rationale:args.rationale,confidence:args.confidence??null,expiresInMinutes:args.expires_in_minutes??120});
      const id=data?.proposal?.id;
      if(!id)throw new Error('Identifiant de proposition absent');
      let verification;
      try { verification=await bridge({action:'wait_trade_batch',proposalIds:[id],timeoutMs:20000}); }
      catch(error){verification={allConfirmed:false,pending:1,total:1,confirmed:0,error:String(error.message||error)};}
      const sc={...data,...verification,proposalIds:[id]};
      const text=sc.allConfirmed===true?'Placement Bybit confirmé. Vérifier aussi tous les autres ordres demandés.':
        'Proposition enregistrée ; placement non confirmé. Continuer wait_trade_batch avec cet ID ou list_trade_proposals. Ne pas recréer l’ordre. '+TRADING_INSTRUCTIONS;
      return {jsonrpc:'2.0',id:msg.id,result:{structuredContent:sc,content:[{type:'text',text}]}};
    } catch(error) {
      return {jsonrpc:'2.0',id:msg.id,result:{isError:true,content:[{type:'text',text:String(error.message||error)}]}};
    }
  }
  return {names,patchTools,handle};
}

/** Only the configured account identity is sent; callers cannot override it. */
export function createTradeBridge({edgeUrl,token,accountFingerprint,fetchImpl=fetch}) {
  const url=new URL(edgeUrl);url.pathname=url.pathname.replace(/\/chk-binance-workspace-latest\/?$/, '/chk-mcp-bridge');
  return async payload=>{
    const response=await fetchImpl(url,{method:'POST',headers:{'content-type':'application/json','x-chk-internal-token':token},
      body:JSON.stringify({...payload,accountFingerprint}),signal:AbortSignal.timeout(28000)});
    const data=await response.json();
    if(!response.ok)throw new Error(`Trade bridge HTTP ${response.status}: ${data.error||data.message||'erreur'}`);
    return data;
  };
}
