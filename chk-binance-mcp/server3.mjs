import http from "node:http";
import crypto from "node:crypto";
import { URL, URLSearchParams } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const MCP_READ_TOKEN = process.env.MCP_READ_TOKEN;
const MCP_TOKEN_SECRET = process.env.MCP_TOKEN_SECRET;
const MCP_LOGIN_PIN = process.env.MCP_LOGIN_PIN;
const SCOPE = "portfolio:read";
const OFFLINE_SCOPE = "offline_access";

for (const [name, value] of Object.entries({
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  MCP_READ_TOKEN,
  MCP_TOKEN_SECRET,
  MCP_LOGIN_PIN,
})) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

function baseUrl(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function resourceUrl(base) {
  return `${base}/mcp`;
}

function normalizeResource(value, base) {
  if (!value || value === base || value === `${base}/`) return resourceUrl(base);
  if (value === resourceUrl(base) || value === `${resourceUrl(base)}/`) return resourceUrl(base);
  return null;
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

async function bodyText(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("request_too_large");
  }
  return body;
}

async function parseBody(req) {
  const raw = await bodyText(req);
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("application/json")) {
    try { return JSON.parse(raw || "{}"); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw).entries());
}

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", MCP_TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes(".")) throw new Error("invalid_token");
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", MCP_TOKEN_SECRET).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) throw new Error("invalid_token");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("expired_token");
  return payload;
}

function randomId(bytes = 18) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function constantEqual(a, b) {
  const A = Buffer.from(String(a || ""));
  const B = Buffer.from(String(b || ""));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function validChatGptClientId(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "chatgpt.com" && u.pathname.endsWith("/client.json");
  } catch {
    return false;
  }
}

function validRedirect(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.hostname === "chatgpt.com" && u.pathname.startsWith("/connector/oauth/");
  } catch {
    return false;
  }
}

function addQuery(url, params) {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") u.searchParams.set(key, value);
  }
  return u.toString();
}

function requestedScopes(value) {
  const scopes = String(value || SCOPE).split(/\s+/).filter(Boolean);
  return scopes.includes(SCOPE) ? scopes : [SCOPE];
}

function oauthForm(params, error = "") {
  const fields = [
    "client_id", "redirect_uri", "response_type", "code_challenge",
    "code_challenge_method", "state", "resource", "scope"
  ].map(key => `<input type="hidden" name="${key}" value="${esc(params[key] || "")}">`).join("\n");

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CHK Binance</title>
<style>
body{margin:0;background:#0b0e11;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh}
.card{width:min(420px,calc(100% - 32px));background:#181a20;border:1px solid #2b3139;border-radius:22px;padding:24px;box-sizing:border-box}
h1{font-size:25px;margin:0 0 8px}.gold{color:#f0b90b}.muted{color:#929aa6;line-height:1.5;font-size:14px}
label{display:block;margin:22px 0 8px;font-weight:700}input[type=password]{width:100%;box-sizing:border-box;padding:14px;border:2px solid #fff;border-radius:12px;background:#0b0e11;color:#fff;font-size:18px}
button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#f0b90b;color:#111;font-weight:800;font-size:16px}.err{color:#ff6670}
</style></head><body><main class="card">
<h1><span class="gold">CHK</span> Binance</h1>
<p class="muted">Autorise ChatGPT à lire le dernier instantané synchronisé par ton APK. Aucun ordre, achat, vente ou retrait n’est possible.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">${fields}
<label for="pin">Code privé MCP</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" required autofocus>
<button type="submit">Autoriser ChatGPT</button></form>
<p class="muted">Accès en lecture seule • La clé secrète Binance reste sur ton téléphone.</p>
</main></body></html>`;
}

function validateAuthorize(params, base) {
  if (params.response_type !== "code") return "response_type non pris en charge";
  if (!validChatGptClientId(params.client_id)) return "client_id ChatGPT invalide";
  if (!validRedirect(params.redirect_uri)) return "redirect_uri ChatGPT invalide";
  if (!params.code_challenge || params.code_challenge_method !== "S256") return "PKCE S256 obligatoire";
  if (params.resource && !normalizeResource(params.resource, base)) return "resource invalide";
  if (!requestedScopes(params.scope).includes(SCOPE)) return "scope portfolio:read obligatoire";
  return null;
}

async function fetchLatestSnapshot() {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/chk_binance_mcp_latest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ p_token: MCP_READ_TOKEN }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 200)}`);
  let data = JSON.parse(text || "null");
  if (Array.isArray(data) && data.length === 1) data = data[0];
  if (!data || !data.snapshot) throw new Error("Aucun instantané Binance synchronisé");
  return data;
}

function portfolioSummary(data) {
  const snapshot = data.snapshot || {};
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
  const topAssets = [...assets]
    .filter(a => Number(a.valueEur || 0) > 0)
    .sort((a,b) => Number(b.valueEur || 0) - Number(a.valueEur || 0))
    .slice(0,5)
    .map(a => ({ asset:a.asset, amount:a.amount, valueEur:a.valueEur, valueUsdt:a.valueUsdt }));
  return {
    syncedAt: data.created_at,
    capturedAt: snapshot.capturedAt || null,
    totalEur: snapshot.totalEur ?? null,
    totalUsdt: snapshot.totalUsdt ?? null,
    eurUsdt: snapshot.eurUsdt ?? null,
    source: snapshot.source || null,
    assetCount: assets.length,
    topAssets,
  };
}

const securitySchemes = [{ type: "oauth2", scopes: [SCOPE] }];
const annotations = { readOnlyHint:true, destructiveHint:false, openWorldHint:false, idempotentHint:true };

const tools = [
  {
    name:"get_portfolio_summary",
    title:"Résumé du portefeuille Binance",
    description:"Use this when the user asks for the current total value, overall Binance portfolio status, or largest holdings from the APK-synchronized snapshot.",
    inputSchema:{ type:"object", properties:{}, additionalProperties:false },
    annotations, securitySchemes,
  },
  {
    name:"list_assets",
    title:"Lister les cryptos du portefeuille",
    description:"Use this when the user asks which crypto assets are held, their quantities, or their EUR/USDT values.",
    inputSchema:{ type:"object", properties:{ top_n:{type:"integer",minimum:1,maximum:50,default:20} }, additionalProperties:false },
    annotations, securitySchemes,
  },
  {
    name:"get_asset",
    title:"Consulter une crypto",
    description:"Use this when the user asks about one specific crypto asset held in the synchronized Binance portfolio.",
    inputSchema:{ type:"object", properties:{ symbol:{type:"string",minLength:1,maxLength:20} }, required:["symbol"], additionalProperties:false },
    annotations, securitySchemes,
  },
  {
    name:"get_latest_snapshot",
    title:"Lire le dernier instantané complet",
    description:"Use this when detailed analysis requires the full latest portfolio snapshot synchronized by the Android APK.",
    inputSchema:{ type:"object", properties:{}, additionalProperties:false },
    annotations, securitySchemes,
  },
];

async function callTool(name, args = {}) {
  const data = await fetchLatestSnapshot();
  const snapshot = data.snapshot || {};
  const assets = Array.isArray(snapshot.assets) ? [...snapshot.assets] : [];
  assets.sort((a,b) => Number(b.valueEur || 0) - Number(a.valueEur || 0));

  if (name === "get_portfolio_summary") {
    const summary = portfolioSummary(data);
    return { content:[{type:"text",text:"Résumé du dernier portefeuille Binance synchronisé."}], structuredContent:summary };
  }
  if (name === "list_assets") {
    const topN = Math.max(1, Math.min(50, Number(args.top_n || 20)));
    return {
      content:[{type:"text",text:`${Math.min(topN, assets.length)} actifs du dernier instantané.`}],
      structuredContent:{ syncedAt:data.created_at, totalEur:snapshot.totalEur, totalUsdt:snapshot.totalUsdt, assets:assets.slice(0,topN) },
    };
  }
  if (name === "get_asset") {
    const symbol = String(args.symbol || "").trim().toUpperCase();
    const asset = assets.find(a => String(a.asset).toUpperCase() === symbol) || null;
    return {
      content:[{type:"text",text:asset ? `${symbol} est présent dans le dernier instantané.` : `${symbol} n’apparaît pas dans le dernier instantané.`}],
      structuredContent:{ syncedAt:data.created_at, found:!!asset, asset },
    };
  }
  if (name === "get_latest_snapshot") {
    return { content:[{type:"text",text:"Dernier instantané complet du portefeuille."}], structuredContent:{syncedAt:data.created_at,snapshot} };
  }
  throw new Error(`Outil inconnu: ${name}`);
}

async function handleRpcObject(message) {
  if (!message || message.jsonrpc !== "2.0") {
    return { jsonrpc:"2.0", id:message?.id ?? null, error:{code:-32600,message:"Invalid Request"} };
  }
  if (message.method === "initialize") {
    return {
      jsonrpc:"2.0", id:message.id,
      result:{
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities:{ tools:{listChanged:false} },
        serverInfo:{ name:"chk-binance-apk", version:"1.2.0" },
        instructions:"Read-only access to the user's latest Binance portfolio snapshot synchronized by the CHK Android APK. No buy, sell, transfer, or withdrawal tools exist.",
      },
    };
  }
  if (message.method === "ping") return {jsonrpc:"2.0",id:message.id,result:{}};
  if (message.method === "tools/list") return {jsonrpc:"2.0",id:message.id,result:{tools}};
  if (message.method === "tools/call") {
    try {
      return {jsonrpc:"2.0",id:message.id,result:await callTool(message.params?.name,message.params?.arguments || {})};
    } catch (error) {
      return {jsonrpc:"2.0",id:message.id,result:{isError:true,content:[{type:"text",text:`Erreur MCP CHK Binance : ${String(error.message || error).slice(0,250)}`}]} };
    }
  }
  if (message.id === undefined || message.id === null) return null;
  return {jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Method not found"}};
}

function authFromRequest(req, base) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) throw new Error("missing_token");
  const payload = verify(header.slice(7));
  if (payload.typ !== "access") throw new Error("invalid_token_type");
  if (normalizeResource(payload.aud, base) !== resourceUrl(base)) throw new Error("invalid_audience");
  if (!String(payload.scope || "").split(/\s+/).includes(SCOPE)) throw new Error("insufficient_scope");
  return payload;
}

function unauthorized(res, base) {
  return json(res, 401, {error:"unauthorized"}, {
    "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="${SCOPE}"`,
  });
}

async function handleMcp(req, res, base) {
  try { authFromRequest(req, base); } catch { return unauthorized(res, base); }

  if (req.method === "GET") {
    res.writeHead(405, {"allow":"POST","cache-control":"no-store"});
    return res.end("Use POST for Streamable HTTP MCP.");
  }
  if (req.method !== "POST") {
    res.writeHead(405, {"allow":"POST"});
    return res.end();
  }

  let parsed;
  try { parsed = JSON.parse(await bodyText(req)); }
  catch { return json(res,400,{jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}}); }

  if (Array.isArray(parsed)) {
    const results = (await Promise.all(parsed.map(handleRpcObject))).filter(Boolean);
    if (!results.length) { res.writeHead(202); return res.end(); }
    return json(res,200,results,{"mcp-protocol-version":"2025-06-18"});
  }

  const result = await handleRpcObject(parsed);
  if (!result) { res.writeHead(202); return res.end(); }
  return json(res,200,result,{"mcp-protocol-version":"2025-06-18"});
}

async function handleAuthorize(req, res, base) {
  if (req.method === "GET") {
    const url = new URL(req.url, base);
    const params = Object.fromEntries(url.searchParams.entries());
    const error = validateAuthorize(params, base);
    console.log("oauth_authorize_get", error ? `error:${error}` : "ok");
    return html(res, error ? 400 : 200, oauthForm(params, error || ""));
  }

  if (req.method === "POST") {
    const params = await parseBody(req);
    const error = validateAuthorize(params, base);
    if (error) {
      console.log("oauth_authorize_post", "params_error", error);
      return html(res,400,oauthForm(params,error));
    }
    if (!constantEqual(params.pin, MCP_LOGIN_PIN)) {
      console.log("oauth_authorize_post", "pin_error");
      return html(res,401,oauthForm(params,"Code privé incorrect."));
    }

    const now = Math.floor(Date.now()/1000);
    const resource = normalizeResource(params.resource, base) || resourceUrl(base);
    const scopes = requestedScopes(params.scope);
    const scope = scopes.join(" ");
    const code = sign({
      typ:"code", jti:randomId(), iat:now, exp:now+300,
      client_id:params.client_id,
      redirect_uri:params.redirect_uri,
      code_challenge:params.code_challenge,
      resource,
      scope,
    });

    const location = addQuery(params.redirect_uri, {
      code,
      state:params.state || undefined,
      iss:base,
    });
    console.log("oauth_authorize_post", "redirect_ok", new URL(params.redirect_uri).pathname, "iss_added");
    res.writeHead(302, {location,"cache-control":"no-store"});
    return res.end();
  }

  res.writeHead(405,{"allow":"GET, POST"});
  res.end();
}

async function handleToken(req, res, base) {
  if (req.method !== "POST") {
    res.writeHead(405,{"allow":"POST"});
    return res.end();
  }

  const params = await parseBody(req);
  const now = Math.floor(Date.now()/1000);

  try {
    if (params.grant_type === "authorization_code") {
      const code = verify(params.code);
      if (code.typ !== "code") throw new Error("invalid_grant");
      if (params.client_id && params.client_id !== code.client_id) throw new Error("invalid_client");
      if (params.redirect_uri && params.redirect_uri !== code.redirect_uri) throw new Error("invalid_grant");
      if (!params.code_verifier || sha256(params.code_verifier) !== code.code_challenge) throw new Error("invalid_grant");
      const resource = normalizeResource(params.resource, base) || code.resource;
      if (normalizeResource(resource, base) !== resourceUrl(base)) throw new Error("invalid_target");

      const accessToken = sign({
        typ:"access", sub:"chk-binance-owner", aud:resourceUrl(base), scope:code.scope || SCOPE,
        client_id:code.client_id, iat:now, exp:now+3600, jti:randomId(),
      });
      const refreshToken = sign({
        typ:"refresh", sub:"chk-binance-owner", aud:resourceUrl(base), scope:code.scope || SCOPE,
        client_id:code.client_id, iat:now, exp:now+30*24*3600, jti:randomId(),
      });
      console.log("oauth_token", "authorization_code_ok");
      return json(res,200,{access_token:accessToken,token_type:"Bearer",expires_in:3600,refresh_token:refreshToken,scope:code.scope || SCOPE});
    }

    if (params.grant_type === "refresh_token") {
      const refresh = verify(params.refresh_token);
      if (refresh.typ !== "refresh") throw new Error("invalid_grant");
      if (params.client_id && params.client_id !== refresh.client_id) throw new Error("invalid_client");
      const resource = normalizeResource(params.resource, base) || refresh.aud;
      if (normalizeResource(resource, base) !== resourceUrl(base)) throw new Error("invalid_target");

      const accessToken = sign({
        typ:"access", sub:refresh.sub, aud:resourceUrl(base), scope:refresh.scope || SCOPE,
        client_id:refresh.client_id, iat:now, exp:now+3600, jti:randomId(),
      });
      const newRefreshToken = sign({
        typ:"refresh", sub:refresh.sub, aud:resourceUrl(base), scope:refresh.scope || SCOPE,
        client_id:refresh.client_id, iat:now, exp:now+30*24*3600, jti:randomId(),
      });
      console.log("oauth_token", "refresh_token_ok");
      return json(res,200,{access_token:accessToken,token_type:"Bearer",expires_in:3600,refresh_token:newRefreshToken,scope:refresh.scope || SCOPE});
    }

    return json(res,400,{error:"unsupported_grant_type"});
  } catch (error) {
    console.log("oauth_token", "error", error.message);
    const code = ["invalid_client","invalid_target"].includes(error.message) ? error.message : "invalid_grant";
    return json(res,400,{error:code,error_description:"Échec de validation OAuth."});
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const base = baseUrl(req);
    const url = new URL(req.url, base);

    if (url.pathname === "/health") {
      return json(res,200,{ok:true,name:"chk-binance-mcp",auth:"oauth2",readOnly:true,version:"1.2.0"});
    }

    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return json(res,200,{
        resource:resourceUrl(base),
        authorization_servers:[base],
        scopes_supported:[SCOPE,OFFLINE_SCOPE],
        bearer_methods_supported:["header"],
        resource_documentation:`${base}/`,
      });
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res,200,{
        issuer:base,
        authorization_endpoint:`${base}/authorize`,
        token_endpoint:`${base}/token`,
        client_id_metadata_document_supported:true,
        authorization_response_iss_parameter_supported:true,
        response_types_supported:["code"],
        grant_types_supported:["authorization_code","refresh_token"],
        token_endpoint_auth_methods_supported:["none"],
        code_challenge_methods_supported:["S256"],
        scopes_supported:[SCOPE,OFFLINE_SCOPE],
      });
    }

    if (url.pathname === "/authorize") return await handleAuthorize(req,res,base);
    if (url.pathname === "/token") return await handleToken(req,res,base);
    if (url.pathname === "/mcp") return await handleMcp(req,res,base);

    if (url.pathname === "/") {
      return html(res,200,`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CHK Binance MCP</title></head><body style="background:#0b0e11;color:white;font-family:system-ui;padding:32px"><h1>CHK Binance MCP</h1><p>Serveur privé en lecture seule.</p><p>Endpoint : <code>${esc(resourceUrl(base))}</code></p><p>Version 1.2.0</p></body></html>`);
    }

    return json(res,404,{error:"not_found"});
  } catch (error) {
    console.error("request_error", error.message || error);
    return json(res,500,{error:"server_error"});
  }
});

server.listen(PORT,"0.0.0.0",()=>console.log(`CHK Binance MCP v1.2 listening on :${PORT}`));
