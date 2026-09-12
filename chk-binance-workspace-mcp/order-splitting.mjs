import {MAX_ORDER_USDC,MAX_BATCH_ORDERS} from './trading-config.mjs';

export function splitLimitOrder(order, {quantityStep=0.00000001,minOrderAmount=1}={}) {
  const quote=Number(order.quoteAmountUsdc), price=Number(order.limitPrice);
  const base=order.baseQuantity==null?null:Number(order.baseQuantity);
  if(!Number.isFinite(quote)||quote<=1||quote>MAX_ORDER_USDC*MAX_BATCH_ORDERS||
      !Number.isFinite(price)||price<=0||!['BUY','SELL'].includes(order.side)||
      (order.orderType&&order.orderType!=='LIMIT')||
      (base!==null&&(!Number.isFinite(base)||base<=0||base*price>quote+1e-8))||
      (order.side==='SELL'&&base===null))throw new Error('invalid_batch_order');
  if(quote<=MAX_ORDER_USDC)return [{...order,orderType:'LIMIT'}];
  const step=Number(quantityStep);
  if(!Number.isFinite(step)||step<=0)throw new Error('invalid_quantity_step');
  const units=Math.floor((base??quote/price)/step+1e-8);
  const maxUnits=Math.floor(MAX_ORDER_USDC/price/step+1e-8);
  if(!Number.isSafeInteger(units)||maxUnits<1)throw new Error('quantity_cannot_be_split');
  const count=Math.ceil(units/maxUnits);
  if(count>MAX_BATCH_ORDERS)throw new Error('too_many_split_orders');
  // Balance the tail when the last slice would be below the exchange minimum.
  const amounts=Array.from({length:count},(_,i)=>Math.min(maxUnits,units-i*maxUnits));
  const minUnits=Math.max(Math.floor(1/price/step)+1,Math.ceil(minOrderAmount/price/step-1e-8));
  if(amounts.at(-1)<minUnits&&count>1){const transfer=minUnits-amounts.at(-1);amounts[count-2]-=transfer;amounts[count-1]+=transfer;}
  if(amounts.some(v=>v<minUnits))throw new Error('split_below_exchange_minimum');
  return amounts.map(u=>{
    const qty=Number((u*step).toPrecision(14)), notional=Number((qty*price).toPrecision(14));
    if(notional>MAX_ORDER_USDC+1e-9)throw new Error('split_exceeds_ceiling');
    return {...order,orderType:'LIMIT',baseQuantity:qty,quoteAmountUsdc:notional};
  });
}

export async function prepareOrders(orders,instrument) {
  if(!Array.isArray(orders)||!orders.length||orders.length>MAX_BATCH_ORDERS)throw new Error('invalid_batch');
  const all=[];
  for(const order of orders){
    if(!/^[A-Z0-9]{2,20}USDC$/.test(order.symbol)||order.symbol==='USDCUSDC')throw new Error('invalid_symbol');
    const rules=Number(order.quoteAmountUsdc)>MAX_ORDER_USDC?await instrument(order.symbol):{};
    all.push(...splitLimitOrder(order,rules));
  }
  if(all.length>MAX_BATCH_ORDERS)throw new Error('too_many_split_orders');
  return all;
}
