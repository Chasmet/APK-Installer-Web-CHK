import http from 'node:http';

const PORT=Number(process.env.PORT||3000);
const CANONICAL='https://chk-binance-workspace-mcp.onrender.com';

function send(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body)});res.end(body);}

const server=http.createServer((req,res)=>{
  if(req.url==='/health') return send(res,200,{ok:true,status:'deprecated',name:'chk-binance-mcp',replacement:'chk-binance-workspace-mcp',canonicalRepository:'Chasmet/Binance-bybyt-',canonicalService:CANONICAL});
  return send(res,410,{error:'legacy_mcp_retired',message:'Ce MCP Binance-only est retiré. Utiliser uniquement @Binance Workspace / chk-binance-workspace-mcp pour CHK Crypto Binance + Bybit EU.',canonicalRepository:'Chasmet/Binance-bybyt-',canonicalService:CANONICAL});
});
server.listen(PORT,'0.0.0.0',()=>console.log(`Legacy chk-binance-mcp retired; canonical=${CANONICAL}`));
