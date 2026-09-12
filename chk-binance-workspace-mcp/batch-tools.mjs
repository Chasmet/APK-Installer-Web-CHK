// Integrate into the existing Render tools/list and tools/call handlers.
// callBridge must reuse the existing authenticated, account-scoped bridge client.
const order = {type:'object',additionalProperties:false,required:['symbol','side','quoteAmountUsdc','limitPrice'],properties:{
  symbol:{type:'string',pattern:'^[A-Z0-9]{2,20}USDC$'},side:{type:'string',enum:['BUY','SELL']},
  orderType:{type:'string',enum:['LIMIT']},quoteAmountUsdc:{type:'number',exclusiveMinimum:1,maximum:30},
  limitPrice:{type:'number',exclusiveMinimum:0},baseQuantity:{type:'number',exclusiveMinimum:0},rationale:{type:'string'}
}};
export const batchTools = [
  {name:'create_trade_batch',description:'Prépare TOUS les ordres demandés dans un lot atomique, puis vérifie leurs confirmations Android/Bybit. Réutiliser le même batchId en cas de retry. Si allConfirmed=false et pending>0, continuer avec wait_trade_batch et les proposalIds retournés, sans recréer les ordres. Ne jamais annoncer le lot placé avant allConfirmed=true. Les plafonds Android restent applicables.',
    inputSchema:{type:'object',additionalProperties:false,required:['batchId','orders'],properties:{batchId:{type:'string',format:'uuid'},orders:{type:'array',minItems:1,maxItems:20,items:order}}},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:true}},
  {name:'wait_trade_batch',description:'Vérifie tous les IDs du lot en lecture seule pendant au maximum 20 secondes. Si pending>0, répéter cet outil sans demander de redonner les ordres. Un blocage, un délai ou une erreur ne sont pas un succès ; détailler chaque résultat. Placé ne veut pas dire rempli.',
    inputSchema:{type:'object',additionalProperties:false,required:['proposalIds'],properties:{proposalIds:{type:'array',minItems:1,maxItems:20,uniqueItems:true,items:{type:'string',format:'uuid'}},timeoutMs:{type:'integer',minimum:0,maximum:20000}}},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}}
];

export async function handleBatchTool(name, args, callBridge) {
  if (!batchTools.some(tool => tool.name === name)) throw new Error('unknown_batch_tool');
  const data = await callBridge({ ...args, action:name });
  const instruction = data.allConfirmed === true
    ? 'Tous les placements du lot sont confirmés. Distinguer placé et rempli.'
    : data.pending > 0
      ? 'Vérification incomplète. Continuer wait_trade_batch avec les mêmes proposalIds ; aucun nouvel ordre.'
      : 'Le lot n’est pas entièrement placé. Présenter les motifs de chaque blocage ou échec.';
  return {content:[{type:'text',text:instruction+'\n'+JSON.stringify(data)}],structuredContent:data,isError:data.ok === false};
}
