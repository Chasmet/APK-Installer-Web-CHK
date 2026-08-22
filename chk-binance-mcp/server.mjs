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
  const proto = (req.headers["x-forwarded-proto"] || "https").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").toString().split(",")[0].trim();
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
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

function empty(res, status = 204) {
  res.writeHead(status, { "cache-control": "no-store" });
  res.end();
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}
function unb64url(input) {
  return Buffer.from(input, "base64url");
}
function signPayload(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", MCP_TOKEN_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifySigned(token) {
  if (!token || !token.includes(".")) throw new Error("invalid_token");
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", MCP_TOKEN_SECRET).update(body).digest();
  const got = unb64url(sig);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) throw new Error("invalid_token");
  const payload = JSON.parse(unb64url(body).toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("expired_token");
  return payload;
}
function randomId(bytes = 18) {
  return crypto.randomBytes(bytes).toString("base64url");
}
function sha256b64url(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}
function esc(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
async function bodyText(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("request_too_large");
  }
  return body;
}
function validChatGptClientId(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      u.hostname === "chatgpt.com" &&
      u.pathname.startsWith("/oauth/") &&
      u.pathname.endsWith("/client.json");
  } catch {
    return false;
  }
}
function validRedirectUri(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      u.hostname === "chatgpt.com" &&
      (u.pathname.startsWith("/connector/oauth/") || u.pathname === "/connector_platform_oauth_redirect");
  } catch {
    return false;
  }
}
function addQuery(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  return u.toString();
}
function authChallenge(base) {
  return `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;
}
function unauthorized(res, base, message = "OAuth authorization required") {
  json(res, 401, { error: "unauthorized", error_description: message }, {
    "www-authenticate": authChallenge(base),
  });
}
function accessFromReq(req, base) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) throw new Error("missing_token");
  const p = verifySigned(h.slice(7));
  if (p.typ !== "access") throw new Error("invalid_token_type");
  if (p.aud !== base) throw new Error("invalid_audience");
  if (!String(p.scope || "").split(/\s+/).includes(SCOPE)) throw new Error("insufficient_scope");
  return p;
}

function oauthForm(params, error = "") {
  const fields = [
    "client_id","redirect_uri","response_type","code_challenge","code_challenge_method","state","resource","scope"
  ].map(k => `<input type="hidden" name="${k}" value="${esc(params[k] || "")}">`).join("\n");
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connexion CHK Binance</title>
<style>
body{margin:0;background:#0b0e11;color:#fff;font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh}
.card{width:min(420px,calc(100% - 32px));background:#181a20;border:1px solid #2b3139;border-radius:22px;padding:24px;box-sizing:border-box}
h1{font-size:25px;margin:0 0 8px}.gold{color:#f0b90b}.muted{color:#929aa6;font-size:14px;line-height:1.45}
label{display:block;margin:22px 0 8px;font-weight:650}input[type=password]{width:100%;box-sizing:border-box;padding:14px;border:1px solid #3a4049;border-radius:12px;background:#0b0e11;color:white;font-size:18px}
button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#f0b90b;color:#111;font-weight:800;font-size:16px}.err{color:#ff6670;margin-top:12px}
.small{font-size:12px;color:#7d8591;margin-top:18px}
</style></head><body><main class="card">
<h1><span class="gold">CHK</span> Binance</h1>
<p class="muted">Autorise ChatGPT à lire le dernier instantané synchronisé par ton APK. Aucun ordre, achat, vente ou retrait n’est possible.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">
${fields}
<label for="pin">Code privé MCP</label>
<input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="one-time-code" required autofocus>
<button type="submit">Autoriser ChatGPT</button>
</form>
<p class="small">Accès en lecture seule • La clé secrète Binance reste sur ton téléphone.</p>
</main></body></html>`;
}

function validateAuthorizeParams(p, base) {
  if (p.response_type !== "code") return "response_type non pris en charge";
  if (!validChatGptClientId(p.client_id)) return "client_id ChatGPT invalide";
  if (!validRedirectUri(p.redirect_uri)) return "redirect_uri ChatGPT invalide";
  if (!p.code_challenge || p.code_challenge_method !== "S256") return "PKCE S256 obligatoire";
  if (p.resource && p.resource !== base) return "resource invalide";
  const scopes = String(p.scope || SCOPE).split(/\s+/).filter(Boolean);
  if (!scopes.includes(SCOPE)) return "scope portfolio:read obligatoire";
  return null;
}

async function fetchLatestSnapshot() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/chk_binance_mcp_latest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apikey": SUPABASE_ANON_KEY,
      "authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ p_token: MCP_READ_TOKEN }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text.slice(0,300)}`);
  let data = JSON.parse(text || "null");
  if (Array.isArray(data) && data.length === 1) data = data[0];
  if (!data || !data.snapshot) throw new Error("Aucun instantané Binance synchronisé");
  return data;
}

function portfolioSummary(data) {
  const s = data.snapshot || {};
  const assets = Array.isArray(s.assets) ? s.assets : [];
  const top = assets
    .filter(a => Number(a.valueEur || 0) > 0)
    .sort((a,b) => Number(b.valueEur || 0) - Number(a.valueEur || 0))
    .slice(0,5)
    .map(a => ({
      asset: a.asset,
      amount: a.amount,
      valueEur: a.valueEur,
      valueUsdt: a.valueUsdt,
    }));
  return {
    syncedAt: data.created_at,
    capturedAt: s.capturedAt || null,
    totalEur: s.totalEur ?? null,
    totalUsdt: s.totalUsdt ?? null,
    eurUsdt: s.eurUsdt ?? null,
    source: s.source || null,
    assetCount: assets.length,
    topAssets: top,
  };
}

const tools = [
  {
    name: "get_portfolio_summary",
    title: "Résumé du portefeuille Binance",
    description: "Use this when the user asks for the current total value, overall Binance portfolio status, or largest holdings from the APK-synchronized snapshot.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    securitySchemes: [{ type: "oauth2", scopes: [SCOPE] }],
  },
  {
    name: "list_assets",
    title: "Lister les cryptos du portefeuille",
    description: "Use this when the user asks which crypto assets are held, their quantities, or their EUR/USDT values.",
    inputSchema: {
      type: "object",
      properties: {
        top_n: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Maximum number of assets, sorted by EUR value." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    securitySchemes: [{ type: "oauth2", scopes: [SCOPE] }],
  },
  {
    name: "get_asset",
    title: "Consulter une crypto",
    description: "Use this when the user asks about one specific crypto asset held in the synchronized Binance portfolio.",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", minLength: 1, maxLength: 20, description: "Asset symbol, for example BTC, RENDER, FET or LINK." } },
      required: ["symbol"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    securitySchemes: [{ type: "oauth2", scopes: [SCOPE] }],
  },
  {
    name: "get_latest_snapshot",
    title: "Lire le dernier instantané complet",
    description: "Use this when detailed analysis requires the full latest portfolio snapshot synchronized by the Android APK.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    securitySchemes: [{ type: "oauth2", scopes: [SCOPE] }],
  }
];

function toolText(message, structuredContent) {
  return {
    content: [{ type: "text", text: message }],
    structuredContent
  };
}

async function callTool(name, args = {}) {
  const data = await fetchLatestSnapshot();
  const s = data.snapshot;
  const assets = Array.isArray(s.assets) ? [...s.assets] : [];
  assets.sort((a,b) => Number(b.valueEur || 0) - Number(a.valueEur || 0));

  if (name === "get_portfolio_summary") {
    const summary = portfolioSummary(data);
    const euro = Number(summary.totalEur || 0).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
    return toolText(`Dernier portefeuille synchronisé : ${euro}, ${summary.assetCount} actifs.`, summary);
  }
  if (name === "list_assets") {
    const topN = Math.max(1, Math.min(50, Number(args.top_n || 20)));
    const out = assets.slice(0, topN).map(a => ({
      asset: a.asset,
      amount: a.amount,
      free: a.free,
      locked: a.locked,
      valueEur: a.valueEur,
      valueUsdt: a.valueUsdt,
      priceUsdt: a.priceUsdt
    }));
    return toolText(`${out.length} actifs du dernier instantané, triés par valeur en euros.`, {
      syncedAt: data.created_at,
      totalEur: s.totalEur,
      totalUsdt: s.totalUsdt,
      assets: out
    });
  }
  if (name === "get_asset") {
    const symbol = String(args.symbol || "").trim().toUpperCase();
    const asset = assets.find(a => String(a.asset).toUpperCase() === symbol);
    if (!asset) {
      return {
        isError: true,
        content: [{ type: "text", text: `${symbol || "Cet actif"} n’apparaît pas dans le dernier instantané Binance.` }],
        structuredContent: { symbol, found: false, syncedAt: data.created_at }
      };
    }
    return toolText(`${symbol} est présent dans le dernier instantané.`, {
      found: true,
      syncedAt: data.created_at,
      asset
    });
  }
  if (name === "get_latest_snapshot") {
    return toolText("Dernier instantané complet du portefeuille synchronisé par l’APK.", {
      syncedAt: data.created_at,
      snapshot: s
    });
  }
  throw new Error(`Outil inconnu: ${name}`);
}

async function handleRpcObject(msg) {
  if (!msg || msg.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (msg.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "chk-binance-apk", version: "1.0.0" },
        instructions: "Read-only access to the user's latest Binance portfolio snapshot synchronized by the CHK Android APK. Never imply live trading access. The server cannot buy, sell, transfer, or withdraw."
      }
    };
  }
  if (msg.method === "ping") {
    return { jsonrpc: "2.0", id: msg.id, result: {} };
  }
  if (msg.method === "tools/list") {
    return { jsonrpc: "2.0", id: msg.id, result: { tools } };
  }
  if (msg.method === "tools/call") {
    try {
      const result = await callTool(msg.params?.name, msg.params?.arguments || {});
      return { jsonrpc: "2.0", id: msg.id, result };
    } catch (e) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Erreur MCP CHK Binance : ${String(e.message || e).slice(0,300)}` }]
        }
      };
    }
  }
  if (msg.id === undefined || msg.id === null) return null;
  return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
}

async function handleMcp(req, res, base) {
  try {
    accessFromReq(req, base);
  } catch {
    return unauthorized(res, base);
  }

  if (req.method === "GET") {
    res.writeHead(405, { "allow": "POST", "cache-control": "no-store" });
    return res.end("Use POST for Streamable HTTP MCP.");
  }
  if (req.method !== "POST") {
    res.writeHead(405, { "allow": "POST" });
    return res.end();
  }

  let parsed;
  try {
    parsed = JSON.parse(await bodyText(req));
  } catch {
    return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  if (Array.isArray(parsed)) {
    const results = (await Promise.all(parsed.map(handleRpcObject))).filter(Boolean);
    if (!results.length) return empty(res, 202);
    return json(res, 200, results, { "mcp-protocol-version": "2025-06-18" });
  }

  const result = await handleRpcObject(parsed);
  if (!result) return empty(res, 202);
  return json(res, 200, result, { "mcp-protocol-version": "2025-06-18" });
}

async function handleAuthorize(req, res, base) {
  if (req.method === "GET") {
    const u = new URL(req.url, base);
    const p = Object.fromEntries(u.searchParams.entries());
    const err = validateAuthorizeParams(p, base);
    if (err) return html(res, 400, oauthForm(p, err));
    return html(res, 200, oauthForm(p));
  }

  if (req.method === "POST") {
    const p = Object.fromEntries(new URLSearchParams(await bodyText(req)).entries());
    const err = validateAuthorizeParams(p, base);
    if (err) return html(res, 400, oauthForm(p, err));
    const pinOk = typeof p.pin === "string" &&
      Buffer.byteLength(p.pin) === Buffer.byteLength(MCP_LOGIN_PIN) &&
      crypto.timingSafeEqual(Buffer.from(p.pin), Buffer.from(MCP_LOGIN_PIN));
    if (!pinOk) return html(res, 401, oauthForm(p, "Code privé incorrect."));

    const now = Math.floor(Date.now()/1000);
    const resource = p.resource || base;
    const scope = String(p.scope || SCOPE).split(/\s+/).filter(Boolean).includes(SCOPE) ? SCOPE : SCOPE;
    const code = signPayload({
      typ: "code",
      jti: randomId(),
      iat: now,
      exp: now + 300,
      client_id: p.client_id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      resource,
      scope
    });
    const location = addQuery(p.redirect_uri, {
      code,
      state: p.state || undefined,
      iss: base
    });
    res.writeHead(302, { location, "cache-control": "no-store" });
    return res.end();
  }

  res.writeHead(405, { allow: "GET, POST" });
  res.end();
}

async function handleToken(req, res, base) {
  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    return res.end();
  }

  const p = Object.fromEntries(new URLSearchParams(await bodyText(req)).entries());
  const now = Math.floor(Date.now()/1000);

  try {
    if (p.grant_type === "authorization_code") {
      const c = verifySigned(p.code);
      if (c.typ !== "code") throw new Error("invalid_grant");
      if (p.client_id !== c.client_id) throw new Error("invalid_client");
      if (p.redirect_uri && p.redirect_uri !== c.redirect_uri) throw new Error("invalid_grant");
      if (!p.code_verifier || sha256b64url(p.code_verifier) !== c.code_challenge) throw new Error("invalid_grant");
      const resource = p.resource || c.resource || base;
      if (resource !== c.resource || resource !== base) throw new Error("invalid_target");

      const access_token = signPayload({
        typ: "access", sub: "chk-binance-owner", aud: resource, scope: SCOPE,
        client_id: c.client_id, iat: now, exp: now + 3600, jti: randomId()
      });
      const refresh_token = signPayload({
        typ: "refresh", sub: "chk-binance-owner", aud: resource, scope: SCOPE,
        client_id: c.client_id, iat: now, exp: now + 30*24*3600, jti: randomId()
      });
      return json(res, 200, { access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope: SCOPE });
    }

    if (p.grant_type === "refresh_token") {
      const r = verifySigned(p.refresh_token);
      if (r.typ !== "refresh") throw new Error("invalid_grant");
      if (p.client_id && p.client_id !== r.client_id) throw new Error("invalid_client");
      const resource = p.resource || r.aud;
      if (resource !== r.aud || resource !== base) throw new Error("invalid_target");
      const access_token = signPayload({
        typ: "access", sub: r.sub, aud: resource, scope: SCOPE,
        client_id: r.client_id, iat: now, exp: now + 3600, jti: randomId()
      });
      const refresh_token = signPayload({
        typ: "refresh", sub: r.sub, aud: resource, scope: SCOPE,
        client_id: r.client_id, iat: now, exp: now + 30*24*3600, jti: randomId()
      });
      return json(res, 200, { access_token, token_type: "Bearer", expires_in: 3600, refresh_token, scope: SCOPE });
    }

    return json(res, 400, { error: "unsupported_grant_type" });
  } catch (e) {
    const code = ["invalid_client","invalid_target"].includes(e.message) ? e.message : "invalid_grant";
    return json(res, 400, { error: code, error_description: "Échec de validation OAuth." });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const base = baseUrl(req);
    const u = new URL(req.url, base);

    if (u.pathname === "/health") {
      return json(res, 200, { ok: true, name: "chk-binance-apk-mcp", auth: "oauth2", readOnly: true });
    }

    if (u.pathname === "/.well-known/oauth-protected-resource") {
      return json(res, 200, {
        resource: base,
        authorization_servers: [base],
        scopes_supported: [SCOPE],
        bearer_methods_supported: ["header"],
        resource_documentation: `${base}/`
      });
    }

    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: [SCOPE]
      });
    }

    if (u.pathname === "/authorize") return await handleAuthorize(req, res, base);
    if (u.pathname === "/token") return await handleToken(req, res, base);
    if (u.pathname === "/mcp") return await handleMcp(req, res, base);

    if (u.pathname === "/") {
      return html(res, 200, `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CHK Binance MCP</title><style>body{background:#0b0e11;color:#fff;font-family:system-ui;padding:32px}.gold{color:#f0b90b}code{background:#181a20;padding:4px 7px;border-radius:6px}</style></head><body><h1><span class="gold">CHK</span> Binance MCP</h1><p>Serveur MCP privé en lecture seule relié aux instantanés synchronisés par l’APK.</p><p>Endpoint : <code>${esc(base)}/mcp</code></p></body></html>`);
    }

    json(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("request_error", e?.message || e);
    json(res, 500, { error: "server_error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CHK Binance MCP listening on :${PORT}`);
});
