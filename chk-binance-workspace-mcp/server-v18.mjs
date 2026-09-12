import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT=Number(process.env.PORT||3000);
const UPSTREAM_PORT=Number(process.env.V18_UPSTREAM_PORT||(PORT+10));
const SERVER_VERSION='18.0.0';
const here=path.dirname(fileURLToPath(import.meta.url));

const child=spawn(process.execPath,['server-v16.mjs'],{
  cwd:here,
  env:{...process.env,PORT:String(UPSTREAM_PORT),V16_UPSTREAM_PORT:String(UPSTREAM_PORT+10)},
  stdio:['ignore','inherit','inherit']
});
child.on('exit',(code,signal)=>console.error(`v16 exited code=${code} signal=${signal}`));

function json(res,status,data,extra={}){
  const body=JSON.stringify(data);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body),...extra});
  res.end(body);
}
async function bodyText(req,max=2_000_000){let body='';for await(const chunk of req){body+=chunk;if(body.length>max)throw new Error('request_too_large');}return body;}
async function upstreamRpc(msg){
  const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/mcp`,{method:'POST',headers:{'content-type':'application/json','mcp-protocol-version':'2025-06-18',accept:'application/json'},body:JSON.stringify(msg)});
  const text=await r.text();
  if(!r.ok)throw new Error(`v16 ${r.status}: ${text.slice(0,240)}`);
  return JSON.parse(text||'{}');
}

const DELEGATED_AUTO_TRADE={
  available:true,
  directMcpTrading:false,
  mode:'proposal_to_apk_auto_trade',
  requiredApkVersion:'0.9.7+',
  flow:'ChatGPT/MCP create_trade_proposal -> CHK Crypto pending proposal -> Auto-Trade CHK -> Bybit EU Spot',
  requirements:[
    'Auto-Trade CHK activé dans l APK',
    'Auto-confirmer les propositions ChatGPT activé',
    'proposition créée après activation Auto-Trade',
    'ordre LIMIT CRYPTO/USDC',
    'montant et plafonds journaliers respectés',
    'clés Bybit SpotTrade présentes dans le stockage chiffré de l APK'
  ],
  rule:'directMcpTrading=false signifie seulement que le MCP ne possède pas et n utilise pas directement les clés Bybit. Cela NE signifie PAS qu une proposition autorisée par l utilisateur ne peut pas être exécutée automatiquement par CHK Crypto.'
};

function appendHint(out,text=''){
  if(!out?.result)return out;
  const sc=out.result.structuredContent&&typeof out.result.structuredContent==='object'?out.result.structuredContent:{};
  out.result.structuredContent={...sc,delegatedAutoTrade:DELEGATED_AUTO_TRADE};
  const content=Array.isArray(out.result.content)?out.result.content:[];
  const hint=text||'CHK Auto-Trade: directMcpTrading=false n interdit pas l exécution automatique. Si CHK Crypto 0.9.7+ a Auto-Trade + auto-confirmation ChatGPT activés, utilise create_trade_proposal; l APK peut ensuite exécuter automatiquement la nouvelle proposition LIMIT selon ses plafonds.';
  if(!content.some(x=>x?.type==='text'&&String(x.text||'').includes('CHK Auto-Trade')))content.push({type:'text',text:hint});
  out.result.content=content;
  return out;
}

function patchToolList(out){
  const tools=Array.isArray(out?.result?.tools)?out.result.tools:[];
  const t=tools.find(x=>x?.name==='create_trade_proposal');
  if(t){
    t.description='Crée une proposition d ordre CHK Crypto. Le MCP n envoie jamais directement l ordre à Bybit. Si CHK Crypto 0.9.7+ a Auto-Trade et Auto-confirmer les propositions ChatGPT activés, une nouvelle proposition LIMIT éligible peut être exécutée automatiquement par l APK sans deuxième clic; sinon elle reste en attente de confirmation.';
  }
  return out;
}

async function handleOne(msg){
  if(msg?.method==='initialize'){
    const out=await upstreamRpc(msg);
    if(out?.result){
      out.result.serverInfo={name:'chk-crypto-workspace',version:SERVER_VERSION};
      out.result.capabilities=out.result.capabilities||{};
      out.result.capabilities.tools={...(out.result.capabilities.tools||{}),listChanged:true};
      out.result.instructions='CHK Crypto v18. Le MCP ne trade jamais directement sur Bybit (directMcpTrading=false), mais CHK Crypto 0.9.7+ prend en charge le TRADING DÉLÉGUÉ : après autorisation utilisateur dans l APK (Auto-Trade actif + Auto-confirmer les propositions ChatGPT), utiliser create_trade_proposal pour créer une nouvelle proposition LIMIT. L APK peut alors la claim et l exécuter automatiquement sur Bybit EU Spot dans les plafonds configurés, sans deuxième clic. Ne pas répondre que l exécution automatique est impossible uniquement parce que directMcpTrading=false. Les propositions antérieures à l activation Auto-Trade ne sont jamais auto-exécutées.';
    }
    return out;
  }
  if(msg?.method==='tools/list')return patchToolList(await upstreamRpc(msg));
  if(msg?.method!=='tools/call')return upstreamRpc(msg);
  const name=String(msg?.params?.name||'');
  const out=await upstreamRpc(msg);
  if(name==='create_trade_proposal'){
    return appendHint(out,'CHK Auto-Trade: proposition créée dans CHK Crypto. Si Auto-Trade + Auto-confirmer les propositions ChatGPT sont activés et que cette nouvelle proposition LIMIT respecte les plafonds, l APK peut l exécuter automatiquement sur Bybit EU Spot sans confirmation supplémentaire. Sinon elle reste en attente dans l APK.');
  }
  if(['get_workspace_info','get_latest_snapshot','get_bybit_market_snapshot','list_trade_proposals'].includes(name))return appendHint(out);
  return out;
}

async function proxy(req,res,raw){
  const target=new URL(req.url,`http://127.0.0.1:${UPSTREAM_PORT}`);
  const r=await fetch(target,{method:req.method,headers:{...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(req.headers.accept?{accept:req.headers.accept}:{}),...(req.headers['mcp-protocol-version']?{'mcp-protocol-version':req.headers['mcp-protocol-version']}:{})},body:raw});
  const text=await r.text();
  res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(text);
}

async function waitForUpstream(){
  for(let i=0;i<480;i++){
    try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);if(r.ok)return;}catch{}
    await new Promise(r=>setTimeout(r,250));
  }
  throw new Error('v16_startup_timeout');
}

const server=http.createServer(async(req,res)=>{
  try{
    const raw=req.method==='GET'||req.method==='HEAD'?undefined:await bodyText(req);
    const u=new URL(req.url,`https://${req.headers.host}`);
    if((u.pathname==='/mcp'||u.pathname.startsWith('/mcp/'))&&req.method==='POST'){
      let parsed;try{parsed=JSON.parse(raw||'{}');}catch{return json(res,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});}
      const out=Array.isArray(parsed)?await Promise.all(parsed.map(handleOne)):await handleOne(parsed);
      return json(res,200,out,{'mcp-protocol-version':'2025-06-18'});
    }
    if(u.pathname==='/health'){
      let upstream={};try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);upstream=await r.json();}catch{}
      return json(res,200,{...upstream,gatewayVersion:SERVER_VERSION,directMcpTrading:false,delegatedAutoTrade:true,autoTradeViaProposal:true,delegatedAutoTradeInfo:DELEGATED_AUTO_TRADE});
    }
    return proxy(req,res,raw);
  }catch(e){
    console.error('v18_request_error',e?.message||e);
    return json(res,500,{error:'server_error',message:String(e?.message||e).slice(0,240)});
  }
});

try{
  await waitForUpstream();
  server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto Gateway v${SERVER_VERSION} delegated Auto-Trade compatibility on :${PORT}`));
}catch(e){
  console.error(e);
  child.kill('SIGTERM');
  process.exit(1);
}
