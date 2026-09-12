import test from 'node:test';
import assert from 'node:assert/strict';
import {createTradingExtension,createTradeBridge,proposalIdsForBatch} from '../trading-extension.mjs';
import {splitLimitOrder} from '../order-splitting.mjs';
import {createBybitOrderReader} from '../bybit-order-reader.mjs';
import {orderLinkId} from '../trading-config.mjs';
const batchId='00000000-0000-0000-0000-000000000001', account='test-account';
const order={symbol:'RENDERUSDC',side:'SELL',orderType:'LIMIT',quoteAmountUsdc:7.35,baseQuantity:5,limitPrice:1.47};
const proposalId=proposalIdsForBatch(account,batchId,1)[0];
const accepted={id:proposalId,proposalStatus:'executed',status:'FILLED',resolved:true,confirmed:true};
test('catalog exposes batches first and shares the 30 USDC ceiling without altering chart bounds',()=>{
 const ext=createTradingExtension({bridge:async()=>{}});
 const tools=ext.patchTools([{name:'zoom_chart',inputSchema:{properties:{steps:{maximum:10}}}},
  {name:'create_trade_proposal',inputSchema:{properties:{quote_amount_usdc:{maximum:10}}}},
  {name:'create_cancel_proposal',inputSchema:{properties:{replacement_quote_amount_usdc:{maximum:10}}}}]);
 assert.deepEqual(tools.slice(0,2).map(t=>t.name),['create_trade_batch','wait_trade_batch']);
 assert.equal(tools.find(t=>t.name==='zoom_chart').inputSchema.properties.steps.maximum,10);
 for(const [name,field] of [['create_trade_proposal','quote_amount_usdc'],['create_cancel_proposal','replacement_quote_amount_usdc']])
  assert.equal(tools.find(t=>t.name===name).inputSchema.properties[field].maximum,30);
});
test('legacy creation persists a stable ID then waits without claiming a premature success',async()=>{
 const calls=[];const ext=createTradingExtension({accountFingerprint:account,bridge:async p=>{
  calls.push(p.action);return p.action==='create_trade_batch'?{proposalIds:[proposalId]}:{allConfirmed:true,reportReady:true,pending:0,orders:[accepted]};
 }});
 const out=await ext.handle({id:1},'create_trade_proposal',{request_id:batchId,symbol:order.symbol,side:order.side,order_type:'LIMIT',quote_amount_usdc:7.35,base_quantity:5,limit_price:1.47});
 assert.equal(calls.filter(x=>x==='create_trade_batch').length,1);
 assert.equal(out.result.structuredContent.allConfirmed,true);assert.ok(calls.includes('wait_trade_batch'));
});
test('lost creation response returns deterministic proposal IDs instead of a new order',async()=>{
 const ext=createTradingExtension({accountFingerprint:account,bridge:async()=>{throw new Error('HTTP 500')}});
 const out=await ext.handle({id:1},'create_trade_batch',{batchId,orders:[order]});
 assert.equal(out.result.structuredContent.creationUncertain,true);
 assert.deepEqual(out.result.structuredContent.proposalIds,[proposalId]);
 assert.equal(out.result.structuredContent.allConfirmed,false);
});
test('five processing orders reconcile by their OrderLinkId before final report',async()=>{
 const ids=proposalIdsForBatch(account,batchId,5),done=new Set(),reads=[];
 const summary=()=>({ok:true,allConfirmed:done.size===5,reportReady:done.size===5,pending:5-done.size,
  orders:ids.map(id=>({id,symbol:order.symbol,side:order.side,proposalStatus:done.has(id)?'executed':'processing',status:done.has(id)?'OPEN':'PROCESSING'}))});
 const ext=createTradingExtension({accountFingerprint:account,readOrder:async o=>{reads.push(orderLinkId(o.id));return{orderId:'bybit-'+o.id,orderLinkId:orderLinkId(o.id)};},
  bridge:async p=>{if(p.action==='create_trade_batch')return{proposalIds:ids};if(p.action==='reconcile_trade_result'){done.add(p.id);return{ok:true};}return summary();}});
 const out=await ext.handle({id:1},'create_trade_batch',{batchId,orders:Array.from({length:5},()=>order)});
 assert.equal(out.result.structuredContent.allConfirmed,true);assert.equal(reads.length,5);
 assert.deepEqual(new Set(reads),new Set(ids.map(orderLinkId)));
});
test('read timeout remains resumable and never repeats creation',async()=>{
 let clock=0,creates=0;const ext=createTradingExtension({accountFingerprint:account,now:()=>clock,sleep:async ms=>{clock+=ms;},
  bridge:async p=>{if(p.action==='create_trade_batch'){creates++;return{proposalIds:[proposalId]};}throw new Error('offline');}});
 const out=await ext.handle({id:1},'create_trade_batch',{batchId,orders:[order]});
 assert.equal(creates,1);assert.equal(out.result.structuredContent.reportReady,false);
 assert.deepEqual(out.result.structuredContent.nextArguments,{proposalIds:[proposalId]});
});
test('cached create_note tool can submit the entire batch through the same pipeline',async()=>{
 let submitted;const ext=createTradingExtension({accountFingerprint:account,bridge:async p=>{
  if(p.action==='create_trade_batch'){submitted=p.orders;return{proposalIds:[proposalId]};}
  return{allConfirmed:true,reportReady:true,pending:0,orders:[accepted]};}});
 const out=await ext.handle({id:1},'create_note',{kind:'TRADE_BATCH',content:JSON.stringify({batchId,orders:[order]})});
 assert.equal(submitted.length,1);assert.equal(out.result.structuredContent.allConfirmed,true);
 assert.equal(ext.isCompatibilityCall('create_note',{kind:'ANALYSIS'}),false);
});
test('23.84 RENDER at 1.47 is exactly two exchange-aligned orders below 30 USDC',()=>{
 const split=splitLimitOrder({...order,quoteAmountUsdc:35.0448,baseQuantity:23.84},{quantityStep:0.01,minOrderAmount:1});
 assert.equal(split.length,2);assert.ok(split.every(o=>o.quoteAmountUsdc<=30&&o.quoteAmountUsdc>1));
 assert.ok(Math.abs(split.reduce((s,o)=>s+o.baseQuantity,0)-23.84)<1e-10);
 assert.ok(Math.abs(split.reduce((s,o)=>s+o.quoteAmountUsdc,0)-35.0448)<1e-10);
});
test('tiny split tail is rebalanced and invalid fifth item inserts nothing',async()=>{
 const split=splitLimitOrder({...order,quoteAmountUsdc:30.3,limitPrice:1,baseQuantity:30.3},{quantityStep:0.1,minOrderAmount:1});
 assert.ok(split.every(o=>o.quoteAmountUsdc>1&&o.quoteAmountUsdc<=30));
 let inserted=false;const ext=createTradingExtension({accountFingerprint:account,bridge:async()=>{inserted=true;}});
 const out=await ext.handle({id:1},'create_trade_batch',{batchId,orders:[order,order,order,order,{...order,limitPrice:NaN}]});
 assert.equal(out.result.isError,true);assert.equal(inserted,false);
});
test('legacy single tool rejects 31 before bridge',async()=>{
 let called=false;const ext=createTradingExtension({bridge:async()=>{called=true;}});
 assert.equal((await ext.handle({id:1},'create_trade_proposal',{quote_amount_usdc:31})).result.isError,true);assert.equal(called,false);
});
test('bridge retries the identical batch after 503 without allowing account injection',async()=>{
 const sent=[];const bridge=createTradeBridge({edgeUrl:'https://example.test/functions/v1/chk-binance-workspace-latest',token:'dummy',accountFingerprint:account,
 fetchImpl:async(url,init)=>{sent.push(JSON.parse(init.body));return{ok:sent.length>1,status:sent.length===1?503:200,json:async()=>({ok:true})};}});
 await bridge({action:'create_trade_batch',batchId,accountFingerprint:'injected'});
 assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(sent[0].accountFingerprint,account);
});
test('Bybit reconciliation uses exact link, falls back to history, and issues GET only',async()=>{
 const calls=[];const reader=createBybitOrderReader({apiKey:'dummy',apiSecret:'dummy',now:()=>100000,
 fetchImpl:async(url,init)=>{calls.push({url,method:init?.method||'GET'});
  if(url.endsWith('/time'))return{ok:true,json:async()=>({retCode:0,time:100000})};
  return{ok:true,status:200,json:async()=>({retCode:0,result:{list:url.includes('/history')?[{symbol:order.symbol,side:'Sell',orderLinkId:orderLinkId(proposalId),orderId:'bybit-found'}]:[{orderLinkId:'different',orderId:'wrong'}]}})};
 }});
 const found=await reader({id:proposalId,symbol:order.symbol,side:order.side});
 assert.equal(found.orderId,'bybit-found');assert.ok(calls.every(c=>c.method==='GET'));
 assert.ok(calls.at(-1).url.includes('orderLinkId='+orderLinkId(proposalId)));
});
test('failed Bybit lookup is never treated as absence eligible for retry',async()=>{
 const reader=createBybitOrderReader({apiKey:'dummy',apiSecret:'dummy',now:()=>100000,fetchImpl:async url=>
  url.endsWith('/time')?{ok:true,json:async()=>({retCode:0,time:100000})}:{ok:false,status:500,json:async()=>({retCode:10000,retMsg:'timeout'})}});
 await assert.rejects(reader({id:proposalId,symbol:order.symbol,side:order.side}),/Bybit lookup/);
});

test('stale OPEN status cannot become a final report when live Bybit lookup fails',async()=>{
 let clock=0;const ext=createTradingExtension({now:()=>clock,sleep:async ms=>{clock+=ms;},readOrder:async()=>{throw new Error('timeout')},
 bridge:async()=>({allConfirmed:true,reportReady:true,pending:0,orders:[{...accepted,status:'OPEN'}]})});
 const out=await ext.handle({id:1},'wait_trade_batch',{proposalIds:[proposalId]});
 assert.equal(out.result.structuredContent.reportReady,false);assert.equal(out.result.structuredContent.allConfirmed,false);
 assert.equal(out.result.structuredContent.orders[0].status,'UNKNOWN');
});
test('cancel replacement accepts 30 USDC and keeps an uncertain response discoverable',async()=>{
 const sent=[];const ext=createTradingExtension({bridge:async p=>{sent.push(p);throw new Error('HTTP 500')}});
 const out=await ext.handle({id:1},'create_cancel_proposal',{symbol:order.symbol,target_order_id:'target',replacement_quote_amount_usdc:30});
 assert.equal(sent[0].replacementQuoteAmountUsdc,30);assert.equal(out.result.structuredContent.nextTool,'list_cancel_proposals');
 assert.equal(sent.length,1);
});
