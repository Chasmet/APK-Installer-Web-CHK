import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT=Number(process.env.PORT||3000);
const UPSTREAM_PORT=Number(process.env.V12_UPSTREAM_PORT||(PORT+10));
const SERVER_VERSION='12.0.0';
const SIGNING_AUDIENCE='chk-crypto-signing';
const EXPECTED_REPOSITORY='Chasmet/Binance-bybyt-';
const EXPECTED_REF='refs/heads/main';
const EXPECTED_WORKFLOW_PREFIX='Chasmet/Binance-bybyt-/.github/workflows/build-apk.yml@';
const ALLOWED_PR_REF=String(process.env.CHK_SIGNING_ALLOWED_PR_REF||'');
const ALLOWED_HEAD_REF=String(process.env.CHK_SIGNING_ALLOWED_HEAD_REF||'');
const EDGE_URL=String(process.env.SUPABASE_EDGE_URL||'');
const SUPABASE_MCP_TOKEN=String(process.env.SUPABASE_MCP_TOKEN||'');
const BINANCE_API_KEY=String(process.env.BINANCE_API_KEY||'').trim();
const BYBIT_API_KEY=String(process.env.BYBIT_API_KEY||'').trim();
const KEYSTORE_B64=String(process.env.CHK_ANDROID_KEYSTORE_BASE64||'');
const STORE_PASSWORD=String(process.env.CHK_ANDROID_STORE_PASSWORD||'');
const KEY_ALIAS=String(process.env.CHK_ANDROID_KEY_ALIAS||'');
const KEY_PASSWORD=String(process.env.CHK_ANDROID_KEY_PASSWORD||'');
const signingConfigured=[KEYSTORE_B64,STORE_PASSWORD,KEY_ALIAS,KEY_PASSWORD].every(v=>v.length>0);
const here=path.dirname(fileURLToPath(import.meta.url));
const child=spawn(process.execPath,['server-v11.mjs'],{cwd:here,env:{...process.env,PORT:String(UPSTREAM_PORT),V11_UPSTREAM_PORT:String(UPSTREAM_PORT+10)},stdio:['ignore','inherit','inherit']});
child.on('exit',(code,signal)=>console.error(`v11 exited code=${code} signal=${signal}`));

function json(res,status,data){const body=JSON.stringify(data);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-length':Buffer.byteLength(body)});res.end(body);}
async function bodyText(req,max=1_000_000){let body='';for await(const chunk of req){body+=chunk;if(body.length>max)throw new Error('request_too_large');}return body;}
function decodeBase64Url(v){return Buffer.from(String(v).replace(/-/g,'+').replace(/_/g,'/'),'base64');}
function sha256(v){return crypto.createHash('sha256').update(String(v)).digest('hex');}
function edgeUrl(slug){const u=new URL(EDGE_URL);u.pathname=u.pathname.replace(/\/chk-binance-workspace-latest\/?$/,`/${slug}`);return u.toString();}
async function waitForUpstream(){for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('v11_startup_timeout');}
async function bootstrapDevice(body){if(!EDGE_URL||!SUPABASE_MCP_TOKEN)throw new Error('bootstrap_not_configured');const deviceId=String(body?.deviceId||'').trim();const deviceSecret=String(body?.deviceSecret||'');if(!/^[a-f0-9-]{32,80}$/i.test(deviceId)||deviceSecret.length<32)throw new Error('invalid_device_credentials');const fingerprints={};if(BINANCE_API_KEY)fingerprints.BINANCE=sha256(BINANCE_API_KEY);if(BYBIT_API_KEY)fingerprints.BYBIT=sha256(BYBIT_API_KEY);const r=await fetch(edgeUrl('chk-device-bootstrap'),{method:'POST',headers:{'content-type':'application/json','x-chk-token':SUPABASE_MCP_TOKEN,'user-agent':'chk-crypto-gateway-v12'},body:JSON.stringify({deviceId,deviceSecret,fingerprints})});if(!r.ok)throw new Error(`device_bootstrap_${r.status}`);}

let jwksCache={expiresAt:0,keys:[]};
async function githubJwks(){if(jwksCache.expiresAt>Date.now()&&jwksCache.keys.length)return jwksCache.keys;const r=await fetch('https://token.actions.githubusercontent.com/.well-known/jwks',{headers:{accept:'application/json','user-agent':'chk-crypto-signing-gateway'}});if(!r.ok)throw new Error(`github_jwks_${r.status}`);const root=await r.json();const keys=Array.isArray(root?.keys)?root.keys:[];if(!keys.length)throw new Error('github_jwks_empty');jwksCache={expiresAt:Date.now()+3600000,keys};return keys;}
function audienceMatches(aud){return typeof aud==='string'?aud===SIGNING_AUDIENCE:Array.isArray(aud)&&aud.includes(SIGNING_AUDIENCE);}
function workflowRefAllowed(c,ref){return String(c?.workflow_ref||'')===`${EXPECTED_WORKFLOW_PREFIX}${ref}`||String(c?.workflow_ref||'')===`${EXPECTED_WORKFLOW_PREFIX}${EXPECTED_REF}`;}
function isAllowedMainRun(c){return c?.ref===EXPECTED_REF&&['push','workflow_dispatch'].includes(String(c?.event_name||''))&&workflowRefAllowed(c,EXPECTED_REF);}
function isAllowedValidationPr(c){return !!ALLOWED_PR_REF&&!!ALLOWED_HEAD_REF&&c?.event_name==='pull_request'&&c?.ref===ALLOWED_PR_REF&&c?.head_ref===ALLOWED_HEAD_REF&&c?.base_ref==='main'&&workflowRefAllowed(c,ALLOWED_PR_REF);}
async function verifyGithubOidc(jwt){const p=String(jwt||'').split('.');if(p.length!==3)throw new Error('invalid_jwt');let h,c;try{h=JSON.parse(decodeBase64Url(p[0]).toString('utf8'));c=JSON.parse(decodeBase64Url(p[1]).toString('utf8'));}catch{throw new Error('invalid_jwt_payload');}if(h?.alg!=='RS256'||!h?.kid)throw new Error('invalid_jwt_header');const keys=await githubJwks();const jwk=keys.find(k=>k?.kid===h.kid&&k?.kty==='RSA');if(!jwk)throw new Error('unknown_github_oidc_key');const pk=crypto.createPublicKey({key:jwk,format:'jwk'});if(!crypto.verify('RSA-SHA256',Buffer.from(`${p[0]}.${p[1]}`),pk,decodeBase64Url(p[2])))throw new Error('invalid_github_oidc_signature');const now=Math.floor(Date.now()/1000);if(c?.iss!=='https://token.actions.githubusercontent.com'||!audienceMatches(c?.aud)||Number(c?.exp)<=now||c?.repository!==EXPECTED_REPOSITORY)throw new Error('oidc_claims_invalid');if(!isAllowedMainRun(c)&&!isAllowedValidationPr(c))throw new Error('run_not_allowed');return c;}
async function handleSigning(req,res){if(req.method!=='POST')return json(res,405,{error:'method_not_allowed'});if(!signingConfigured)return json(res,503,{error:'signing_not_configured'});const auth=String(req.headers.authorization||'');if(!auth.startsWith('Bearer '))return json(res,401,{error:'missing_oidc_token'});try{const c=await verifyGithubOidc(auth.slice(7).trim());console.log(`Android signing material issued repo=${c.repository} ref=${c.ref} run_id=${c.run_id||'unknown'}`);return json(res,200,{ok:true,keystoreBase64:KEYSTORE_B64,storePassword:STORE_PASSWORD,keyAlias:KEY_ALIAS,keyPassword:KEY_PASSWORD});}catch(e){console.warn(`Android signing OIDC rejected: ${e?.message||e}`);return json(res,403,{error:'oidc_forbidden'});}}
async function proxyWithBody(req,res,body){const target=new URL(req.url,`http://127.0.0.1:${UPSTREAM_PORT}`);const r=await fetch(target,{method:req.method,headers:{...(req.headers['content-type']?{'content-type':req.headers['content-type']}:{}),...(req.headers.accept?{accept:req.headers.accept}:{}),...(req.headers['mcp-protocol-version']?{'mcp-protocol-version':req.headers['mcp-protocol-version']}:{}),...(req.headers.authorization?{authorization:req.headers.authorization}:{})},body});const text=await r.text();res.writeHead(r.status,{'content-type':r.headers.get('content-type')||'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);}

const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,`https://${req.headers.host}`);if(url.pathname==='/ci/android-signing')return handleSigning(req,res);if(url.pathname==='/health'){const r=await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);const h=await r.json();return json(res,200,{...h,gatewayVersion:SERVER_VERSION,stableSigningConfigured:signingConfigured,deviceBootstrap:true,canonicalRepository:EXPECTED_REPOSITORY});}if(url.pathname.startsWith('/apk/')&&req.method==='POST'){const body=await bodyText(req,100_000);let parsed={};try{parsed=JSON.parse(body||'{}');}catch{return json(res,400,{error:'invalid_json'});}await bootstrapDevice(parsed);return proxyWithBody(req,res,body);}const body=req.method==='GET'||req.method==='HEAD'?undefined:await bodyText(req);return proxyWithBody(req,res,body);}catch(e){console.error('v12_request_error',e?.message||e);return json(res,500,{error:'server_error',message:String(e?.message||e).slice(0,200)});}});

try{await waitForUpstream();server.listen(PORT,'0.0.0.0',()=>console.log(`CHK Crypto Gateway v${SERVER_VERSION} canonical v11 tools on :${PORT}`));}catch(e){console.error(e);child.kill('SIGTERM');process.exit(1);}
