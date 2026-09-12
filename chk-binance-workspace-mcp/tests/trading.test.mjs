import test from 'node:test';
import assert from 'node:assert/strict';
import {createTradingExtension,createTradeBridge} from '../trading-extension.mjs';
const proposalId='00000000-0000-0000-0000-000000000001';
test('registers batch tools and updates only monetary schemas',()=>{
 const ext=createTradingExtension({bridge:async()=>{}});
 const tools=ext.patchTools([{name:'zoom_chart',inputSchema:{properties:{steps:{maximum:10}}}},
  {name:'create_trade_proposal',inputSchema:{properties:{quote_amount_usdc:{maximum:10}}}},
  {name:'create_cancel_proposal',inputSchema:{properties:{replacement_quote_amount_usdc:{maximum:10}}}}]);
 assert.equal(tools.find(x=>x.name==='zoom_chart').inputSchema.properties.steps.maximum,10);
 assert.equal(tools.find(x=>x.name==='create_trade_proposal').inputSchema.properties.quote_amount_usdc.maximum,30);
 assert.equal(tools.find(x=>x.name==='create_cancel_proposal').inputSchema.properties.replacement_quote_amount_usdc.maximum,30);
 assert.equal(tools.filter(x=>x.name==='create_trade_batch').length,1);
});
test('legacy creation waits for actual confirmation',async()=>{
 const calls=[]; const ext=createTradingExtension({bridge:async x=>{calls.push(x.action);return x.action==='create_trade_proposal'?{proposal:{id:proposalId}}:{allConfirmed:true,pending:0};}});
 const out=await ext.handle({id:1},'create_trade_proposal',{quote_amount_usdc:30,order_type:'LIMIT'});
 assert.deepEqual(calls,['create_trade_proposal','wait_trade_batch']);assert.equal(out.result.structuredContent.allConfirmed,true);
});
test('receipt read failure preserves ID and requests follow-up without another creation',async()=>{
 let creates=0;const ext=createTradingExtension({bridge:async x=>{if(x.action==='create_trade_proposal'){creates++;return{proposal:{id:proposalId}};}throw new Error('offline');}});
 const out=await ext.handle({id:1},'create_trade_proposal',{quote_amount_usdc:5});
 assert.equal(creates,1);assert.equal(out.result.structuredContent.allConfirmed,false);
 assert.deepEqual(out.result.structuredContent.proposalIds,[proposalId]);
});
test('rejects amount above 30 before reaching bridge',async()=>{
 const ext=createTradingExtension({bridge:async()=>{throw new Error('must not run')}});
 assert.equal((await ext.handle({id:1},'create_trade_proposal',{quote_amount_usdc:31})).result.isError,true);
});
test('account identity cannot be supplied by tool arguments',async()=>{
 let sent;
 const bridge=createTradeBridge({edgeUrl:'https://example.test/functions/v1/chk-binance-workspace-latest',token:'dummy',accountFingerprint:'trusted',fetchImpl:async(url,init)=>{sent=JSON.parse(init.body);return{ok:true,json:async()=>({ok:true})}}});
 await bridge({action:'wait_trade_batch',accountFingerprint:'injected'});
 assert.equal(sent.accountFingerprint,'trusted');
});
