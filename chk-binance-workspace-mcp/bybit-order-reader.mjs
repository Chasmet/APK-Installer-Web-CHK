import crypto from 'node:crypto';
import {orderLinkId} from './trading-config.mjs';

/** Deliberately GET-only. An unavailable endpoint is never evidence that an order is absent. */
export function createBybitOrderReader({apiKey,apiSecret,baseUrl='https://api.bybit.eu',fetchImpl=fetch,now=Date.now}) {
  let offset=0, synced=0;
  async function get(path, params, deadline) {
    const query=new URLSearchParams(params).toString(), timestamp=String(now()+offset), recv='5000';
    const signature=crypto.createHmac('sha256',apiSecret).update(timestamp+apiKey+recv+query).digest('hex');
    if(now()>=deadline)throw new Error('verification_deadline');
    const response=await fetchImpl(`${baseUrl}${path}?${query}`,{method:'GET',signal:AbortSignal.timeout(Math.max(1,Math.min(4000,deadline-now()))),headers:{
      'X-BAPI-API-KEY':apiKey,'X-BAPI-TIMESTAMP':timestamp,'X-BAPI-RECV-WINDOW':recv,'X-BAPI-SIGN':signature}});
    const data=await response.json();
    if(!response.ok||Number(data.retCode)!==0)throw new Error(`Bybit lookup ${response.status}/${data.retCode}: ${data.retMsg||'unavailable'}`);
    return data.result?.list||[];
  }
  return async (proposal,{deadline=now()+12000}={})=>{
    if(!apiKey||!apiSecret)throw new Error('bybit_read_credentials_missing');
    if(now()-synced>60000){
      if(now()>=deadline)throw new Error('verification_deadline');
      const r=await fetchImpl(`${baseUrl}/v5/market/time`,{signal:AbortSignal.timeout(Math.max(1,Math.min(4000,deadline-now())))});
      const j=await r.json();if(!r.ok||Number(j.retCode)!==0)throw new Error('bybit_time_unavailable');
      const time=Number(j.time||Number(j.result?.timeSecond)*1000);
      if(!Number.isFinite(time)||time<=0)throw new Error('bybit_time_invalid');
      offset=time-now();synced=now();
    }
    const link=orderLinkId(proposal.id);
    let firstError=null;
    for(const endpoint of ['/v5/order/realtime','/v5/order/history']){
      try{
        const rows=await get(endpoint,{category:'spot',symbol:proposal.symbol,orderLinkId:link,limit:'20'},deadline);
        const found=rows.find(r=>r.orderLinkId===link&&r.symbol===proposal.symbol&&String(r.side).toUpperCase()===proposal.side&&r.orderId);
        if(found)return found;
      }catch(e){firstError=e;}
    }
    if(firstError)throw firstError;
    return null;
  };
}
