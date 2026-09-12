import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.V6_MCP_INTERNAL_PORT || (PORT + 1));
const MCP_LINK_TOKEN = process.env.MCP_LINK_TOKEN;
const SERVER_VERSION = '7.1.0';
const BLOCKED_WRITE_TOOLS = new Set([
  'place_bybit_limit_order',
  'place_bybit_market_order',
  'cancel_bybit_order',
]);

if (!MCP_LINK_TOKEN) {
  console.error('Missing required environment variable: MCP_LINK_TOKEN');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, ['server-v6.mjs'], {
  cwd: here,
  env: {
    ...process.env,
    PORT: String(INTERNAL_PORT),
    V5_MCP_INTERNAL_PORT: String(INTERNAL_PORT + 1),
    V4_MCP_INTERNAL_PORT: String(INTERNAL_PORT + 2),
    BASE_MCP_INTERNAL_PORT: String(INTERNAL_PORT + 3),
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (code, signal) => console.error(`v6 MCP exited code=${code} signal=${signal}`));

function json(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
    expires: '0',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

async function bodyText(req, max = 1_000_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) throw new Error('request_too_large');
  }
  return body;
}

function constantEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function validMcpPath(pathname) {
  return pathname.startsWith('/mcp/') && constantEqual(pathname.slice(5), MCP_LINK_TOKEN);
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function v6Fetch(pathname, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${INTERNAL_PORT}${pathname}`, options);
    } catch (error) {
      lastError = error;
      if (attempt < 11) await wait(250);
    }
  }
  throw lastError || new Error('v6 MCP indisponible');
}

async function v6Rpc(message) {
  const r = await v6Fetch(`/mcp/${encodeURIComponent(MCP_LINK_TOKEN)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      accept: 'application/json',
    },
    body: JSON.stringify(message),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`v6 MCP ${r.status}: ${text.slice(0, 240)}`);
  return text ? JSON.parse(text) : null;
}

async function internalTool(name, args = {}) {
  return v6Rpc({
    jsonrpc: '2.0',
    id: `internal-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function resultError(response) {
  if (!response?.result?.isError) return null;
  const content = Array.isArray(response.result.content) ? response.result.content : [];
  return content.map((x) => x?.text).filter(Boolean).join(' | ') || 'Erreur Bybit inconnue';
}

function withExchange(items, exchange) {
  return (Array.isArray(items) ? items : []).map((item) => ({ exchange, ...item }));
}

function blockedWriteResult(message) {
  return {
    jsonrpc: '2.0',
    id: message?.id ?? null,
    result: {
      isError: true,
      content: [{
        type: 'text',
        text: 'Écriture Bybit directe désactivée. ChatGPT doit créer une proposition CHK Crypto ; seul l’utilisateur peut ensuite appuyer sur CONFIRMER dans l’APK avant l’envoi réel à Bybit EU Spot.',
      }],
    },
  };
}

async function mergeReadTool(message, original) {
  const name = message?.params?.name;
  const args = message?.params?.arguments || {};
  const baseResult = original?.result || {};
  const binanceStructured = baseResult.structuredContent ?? null;

  if (name === 'get_portfolio_summary') {
    const bybit = await internalTool('get_bybit_portfolio_summary');
    const bybitError = resultError(bybit);
    return {
      ...original,
      result: {
        ...baseResult,
        content: [{
          type: 'text',
          text: bybitError
            ? `CHK Crypto Workspace : Binance disponible. Lecture Bybit en erreur : ${bybitError}`
            : 'CHK Crypto Workspace : résumé Binance synchronisé + portefeuille Bybit EU live. Utilise les deux blocs ci-dessous ; ne présente pas le bloc Binance comme étant le portefeuille Bybit.',
        }],
        structuredContent: {
          workspace: 'CHK Crypto Workspace',
          mode: 'BINANCE_PLUS_BYBIT',
          binance: binanceStructured,
          bybit: bybit?.result?.structuredContent ?? null,
          bybitError,
          instruction: 'Quand la demande concerne Bybit, utiliser uniquement le bloc bybit. Quand elle concerne Binance, utiliser uniquement le bloc binance.',
        },
      },
    };
  }

  if (name === 'list_assets') {
    const topN = Math.max(1, Math.min(50, Number(args.top_n || 20)));
    const bybit = await internalTool('list_bybit_assets', { top_n: topN });
    const bybitError = resultError(bybit);
    const binanceAssets = binanceStructured?.assets || binanceStructured?.holdings || binanceStructured?.topAssets || [];
    const bybitStructured = bybit?.result?.structuredContent ?? null;
    const bybitAssets = bybitStructured?.assets || bybitStructured?.holdings || bybitStructured?.topAssets || [];
    const assets = [
      ...withExchange(binanceAssets, 'BINANCE'),
      ...withExchange(bybitAssets, 'BYBIT'),
    ];
    return {
      ...original,
      result: {
        ...baseResult,
        content: [{
          type: 'text',
          text: bybitError
            ? `Actifs Binance chargés. Lecture Bybit en erreur : ${bybitError}`
            : `Actifs Binance + Bybit chargés (${assets.length} lignes combinées). Chaque ligne contient le champ exchange.`,
        }],
        structuredContent: {
          workspace: 'CHK Crypto Workspace',
          mode: 'BINANCE_PLUS_BYBIT',
          assets,
          binance: binanceStructured,
          bybit: bybitStructured,
          bybitError,
          instruction: 'Filtrer par exchange=BYBIT pour toute demande Bybit.',
        },
      },
    };
  }

  if (name === 'get_asset') {
    const symbol = String(args.symbol || '').trim().toUpperCase();
    const bybitList = await internalTool('list_bybit_assets', { top_n: 50 });
    const bybitError = resultError(bybitList);
    const bybitStructured = bybitList?.result?.structuredContent ?? null;
    const bybitAssets = bybitStructured?.assets || [];
    const bybitAsset = bybitAssets.find((a) => String(a?.coin || a?.asset || '').toUpperCase() === symbol) || null;
    return {
      ...original,
      result: {
        ...baseResult,
        content: [{
          type: 'text',
          text: bybitError
            ? `${symbol}: donnée Binance disponible ; lecture Bybit en erreur.`
            : `${symbol}: recherche effectuée sur Binance et Bybit EU.`,
        }],
        structuredContent: {
          workspace: 'CHK Crypto Workspace',
          symbol,
          binance: binanceStructured,
          bybit: bybitAsset,
          bybitError,
          instruction: 'Si la demande vise Bybit, répondre depuis bybit et non depuis binance.',
        },
      },
    };
  }

  if (name === 'get_latest_snapshot') {
    const [bybitSummary, bybitAssets, bybitExecutions] = await Promise.all([
      internalTool('get_bybit_portfolio_summary'),
      internalTool('list_bybit_assets', { top_n: 50 }),
      internalTool('list_bybit_recent_executions', { limit: 50 }),
    ]);
    const bybitErrors = [resultError(bybitSummary), resultError(bybitAssets), resultError(bybitExecutions)].filter(Boolean);
    return {
      ...original,
      result: {
        ...baseResult,
        content: [{
          type: 'text',
          text: bybitErrors.length
            ? `Snapshot combiné préparé avec erreurs Bybit : ${bybitErrors.join(' | ')}`
            : 'Snapshot complet CHK Crypto préparé : Binance synchronisé + Bybit EU live + exécutions Spot Bybit récentes.',
        }],
        structuredContent: {
          workspace: 'CHK Crypto Workspace',
          mode: 'BINANCE_PLUS_BYBIT',
          binance: binanceStructured,
          bybit: {
            summary: bybitSummary?.result?.structuredContent ?? null,
            assets: bybitAssets?.result?.structuredContent ?? null,
            recentExecutions: bybitExecutions?.result?.structuredContent ?? null,
          },
          bybitErrors,
          instruction: 'Ne jamais confondre les données Binance et Bybit. Utiliser le bloc correspondant à la demande.',
        },
      },
    };
  }

  return original;
}

async function rpcOne(message) {
  if (!message || message.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }

  if (message.method === 'initialize') {
    const response = await v6Rpc(message);
    if (response?.result) {
      response.result.serverInfo = { name: 'chk-crypto-workspace', version: SERVER_VERSION };
      response.result.instructions = 'CHK Crypto Workspace v7.1. Binance + Bybit read/analysis tools only. Direct Bybit LIMIT/MARKET/cancel writes are blocked at this gateway. Real orders must pass through a CHK Crypto proposal and the user confirmation button in the Android APK.';
    }
    return response;
  }

  if (message.method === 'tools/list') {
    const response = await v6Rpc(message);
    const tools = Array.isArray(response?.result?.tools) ? response.result.tools : [];
    if (response?.result) response.result.tools = tools.filter((tool) => !BLOCKED_WRITE_TOOLS.has(tool?.name));
    return response;
  }

  if (message.method === 'tools/call') {
    const name = String(message?.params?.name || '');
    console.log(`[MCP v7.1] tools/call ${name}`);
    if (BLOCKED_WRITE_TOOLS.has(name)) return blockedWriteResult(message);

    const original = await v6Rpc(message);
    if (['get_portfolio_summary', 'list_assets', 'get_asset', 'get_latest_snapshot'].includes(name)) {
      try {
        return await mergeReadTool(message, original);
      } catch (error) {
        console.error(`[MCP v7.1] merge ${name} failed`, error?.message || error);
        return original;
      }
    }
    return original;
  }

  return v6Rpc(message);
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
  let parsed;
  try {
    parsed = JSON.parse(await bodyText(req));
  } catch {
    return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  const out = Array.isArray(parsed)
    ? (await Promise.all(parsed.map(rpcOne))).filter(Boolean)
    : await rpcOne(parsed);

  if ((Array.isArray(out) && !out.length) || out == null) {
    res.writeHead(202, { 'cache-control': 'no-store' });
    return res.end();
  }
  return json(res, 200, out, { 'mcp-protocol-version': '2025-06-18' });
}

async function proxy(req, res, pathname) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bodyText(req);
  const r = await v6Fetch(pathname, {
    method: req.method,
    headers: {
      ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
      accept: 'application/json',
    },
    body,
  });
  const text = await r.text();
  res.writeHead(r.status, {
    'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);

    if (validMcpPath(url.pathname)) return handleMcp(req, res);

    if (url.pathname === '/health') {
      const r = await v6Fetch('/health', { headers: { accept: 'application/json' } });
      const base = await r.json();
      return json(res, 200, {
        ...base,
        ok: true,
        name: 'chk-crypto-workspace',
        version: SERVER_VERSION,
        compatibilityReadBridge: true,
        directBybitWrites: false,
        compatibilityReadTools: ['get_portfolio_summary', 'list_assets', 'get_asset', 'get_latest_snapshot'],
      });
    }

    if (url.pathname === '/') {
      return json(res, 200, {
        name: 'CHK Crypto Workspace MCP',
        version: SERVER_VERSION,
        status: 'online',
        compatibilityReadBridge: true,
        directBybitWrites: false,
        note: 'Binance + Bybit lecture/analyse. Tout ordre réel Bybit doit passer par une proposition CHK Crypto puis une confirmation humaine dans l’APK.',
      });
    }

    return proxy(req, res, url.pathname);
  } catch (error) {
    console.error('request_error', error?.message || error);
    return json(res, 500, { error: 'server_error', message: String(error.message || error).slice(0, 240) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CHK Crypto Workspace MCP v7.1 listening on :${PORT}; v6 base on :${INTERNAL_PORT}`);
});
