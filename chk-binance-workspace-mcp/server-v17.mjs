import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_PORT = Number(process.env.V17_UPSTREAM_PORT || (PORT + 10));
const SERVER_VERSION = '17.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));

const child = spawn(
  process.execPath,
  ['server-v16.mjs'],
  {
    cwd: here,
    env: {
      ...process.env,
      PORT: String(UPSTREAM_PORT),
      V16_UPSTREAM_PORT: String(UPSTREAM_PORT + 10),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  },
);
child.on('exit', (code, signal) => console.error(`v16 exited code=${code} signal=${signal}`));

function json(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

async function bodyText(req, max = 2_000_000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) throw new Error('request_too_large');
  }
  return body;
}

async function upstreamRpc(msg) {
  const r = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-06-18',
      accept: 'application/json',
    },
    body: JSON.stringify(msg),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`v16 ${r.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text || '{}');
}

async function proxy(req, res, raw) {
  const target = new URL(req.url, `http://127.0.0.1:${UPSTREAM_PORT}`);
  const headers = {};
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (req.headers.accept) headers.accept = req.headers.accept;
  if (req.headers['mcp-protocol-version']) headers['mcp-protocol-version'] = req.headers['mcp-protocol-version'];
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
  const r = await fetch(target, { method: req.method, headers, body: raw });
  const text = await r.text();
  res.writeHead(r.status, {
    'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

const READ_ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_ANN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const ANALYSIS_ACTIONS = [
  'get_state',
  'set_symbol',
  'set_timeframe',
  'zoom_in',
  'zoom_out',
  'pan_left',
  'pan_right',
  'go_to_latest',
  'reset_view',
  'set_auto_scale',
  'set_visible_range',
  'set_indicators',
  'set_profile',
];

const analysisTools = [
  {
    name: 'get_analysis_access',
    title: 'Accès complet onglet Analyse',
    description: 'Retourne l’état réel du graphique CHK Crypto et la liste des contrôles MCP disponibles dans l’onglet Analyse.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ANN,
  },
  {
    name: 'control_analysis',
    title: 'Piloter l’onglet Analyse',
    description: 'Commande unifiée du graphique réel CHK Crypto : paire, timeframe, zoom, déplacement, plage visible, Auto Scale, profil et indicateurs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ANALYSIS_ACTIONS },
        symbol: { type: 'string' },
        timeframe: { type: 'string', enum: ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d','3d','1w'] },
        candles: { type: 'integer', minimum: 1, maximum: 500 },
        visible_count: { type: 'integer', minimum: 12, maximum: 600 },
        offset_from_end: { type: 'integer', minimum: 0 },
        enabled: { type: 'boolean' },
        profile: { type: 'string', enum: ['SCALP','INTRADAY','SWING'] },
        ma: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 500 }, maxItems: 12 },
        ema: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 500 }, maxItems: 12 },
        volume: { type: 'boolean' },
        bollinger: { type: 'boolean' },
        rsi: { type: 'integer', minimum: 2, maximum: 100 },
        macd: { type: 'boolean' },
        atr: { type: 'integer', minimum: 2, maximum: 100 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: WRITE_ANN,
  },
];

function result(id, data, text) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text }],
      structuredContent: data,
    },
  };
}

function upstreamToolCall(id, name, args = {}) {
  return upstreamRpc({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
}

function structured(out) {
  return out?.result?.structuredContent || {};
}

async function handleAnalysisControl(msg, args) {
  const action = String(args.action || '');
  if (!ANALYSIS_ACTIONS.includes(action)) throw new Error('Action Analyse invalide');

  switch (action) {
    case 'get_state':
      return upstreamToolCall(msg.id, 'get_chart_state', {});
    case 'set_symbol':
      if (!args.symbol) throw new Error('symbol requis');
      return upstreamToolCall(msg.id, 'set_chart_symbol', { symbol: args.symbol });
    case 'set_timeframe':
      if (!args.timeframe) throw new Error('timeframe requis');
      return upstreamToolCall(msg.id, 'set_chart_timeframe', { timeframe: args.timeframe });
    case 'zoom_in':
      return upstreamToolCall(msg.id, 'chart_zoom_in', {});
    case 'zoom_out':
      return upstreamToolCall(msg.id, 'chart_zoom_out', {});
    case 'pan_left':
      return upstreamToolCall(msg.id, 'chart_pan_left', { candles: args.candles ?? 20 });
    case 'pan_right':
      return upstreamToolCall(msg.id, 'chart_pan_right', { candles: args.candles ?? 20 });
    case 'go_to_latest':
      return upstreamToolCall(msg.id, 'chart_go_to_latest', {});
    case 'reset_view':
      return upstreamToolCall(msg.id, 'chart_reset_view', {});
    case 'set_auto_scale':
      return upstreamToolCall(msg.id, 'set_chart_auto_scale', { enabled: args.enabled !== false });
    case 'set_visible_range': {
      const out = {};
      if (args.visible_count !== undefined) out.visible_count = args.visible_count;
      if (args.offset_from_end !== undefined) out.offset_from_end = args.offset_from_end;
      return upstreamToolCall(msg.id, 'set_chart_visible_range', out);
    }
    case 'set_indicators': {
      const out = {};
      for (const key of ['ma','ema','volume','bollinger','rsi','macd','atr']) {
        if (args[key] !== undefined) out[key] = args[key];
      }
      return upstreamToolCall(msg.id, 'set_chart_indicators', out);
    }
    case 'set_profile':
      if (!args.profile) throw new Error('profile requis');
      return upstreamToolCall(msg.id, 'set_chart_profile', { profile: args.profile });
    default:
      throw new Error('Action Analyse non gérée');
  }
}

async function handleOne(msg) {
  if (msg?.method === 'initialize') {
    const out = await upstreamRpc(msg);
    if (out?.result) {
      out.result.serverInfo = { name: 'chk-crypto-workspace', version: SERVER_VERSION };
      out.result.capabilities = out.result.capabilities || {};
      out.result.capabilities.tools = { ...(out.result.capabilities.tools || {}), listChanged: true };
      out.result.instructions = `${out.result.instructions || ''} CHK Crypto v17 ajoute un accès MCP unifié à l’onglet Analyse via get_analysis_access et control_analysis : lecture état réel, paire, timeframe, zoom, pan, plage visible, Auto Scale, profils et indicateurs. Le pinch tactile reste local à l’APK. Aucun ordre réel sans confirmation utilisateur.`.trim();
    }
    return out;
  }

  if (msg?.method === 'tools/list') {
    const out = await upstreamRpc(msg);
    const tools = Array.isArray(out?.result?.tools) ? out.result.tools : [];
    for (const tool of analysisTools) {
      if (!tools.some((x) => x?.name === tool.name)) tools.push(tool);
    }
    if (out?.result) out.result.tools = tools;
    return out;
  }

  if (msg?.method !== 'tools/call') return upstreamRpc(msg);
  const name = String(msg?.params?.name || '');
  const args = msg?.params?.arguments || {};

  if (name === 'get_analysis_access') {
    const stateOut = await upstreamToolCall(msg.id, 'get_chart_state', {});
    const state = structured(stateOut);
    return result(
      msg.id,
      {
        ok: true,
        gatewayVersion: SERVER_VERSION,
        actions: ANALYSIS_ACTIONS,
        directTools: [
          'get_chart_state','get_chart_visible_range','get_chart_candles','get_chart_indicators','get_chart_drawings','get_chart_crosshair','get_chart_snapshot',
          'set_chart_symbol','set_chart_timeframe','set_chart_indicators','set_chart_visible_range','chart_zoom_in','chart_zoom_out','chart_pan_left','chart_pan_right',
          'chart_go_to_latest','chart_reset_view','set_chart_auto_scale','set_chart_profile','set_chart_crosshair','add_chart_drawing','update_chart_drawing','remove_chart_drawing','clear_chart_drawings',
        ],
        state,
      },
      'Accès MCP complet à l’onglet Analyse CHK Crypto disponible.',
    );
  }

  if (name === 'control_analysis') return handleAnalysisControl(msg, args);
  return upstreamRpc(msg);
}

async function waitForUpstream() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('v16_startup_timeout');
}

const server = http.createServer(async (req, res) => {
  try {
    const raw = req.method === 'GET' || req.method === 'HEAD' ? undefined : await bodyText(req);
    const u = new URL(req.url, `https://${req.headers.host}`);

    if (u.pathname === '/mcp' && req.method === 'POST') {
      let parsed;
      try {
        parsed = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const out = Array.isArray(parsed)
        ? await Promise.all(parsed.map((x) => handleOne(x)))
        : await handleOne(parsed);
      return json(res, 200, out, { 'mcp-protocol-version': '2025-06-18' });
    }

    if (u.pathname === '/health') {
      let upstream = {};
      try {
        const r = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/health`);
        upstream = await r.json();
      } catch {}
      return json(res, 200, {
        ...upstream,
        gatewayVersion: SERVER_VERSION,
        analysisMcpComplete: true,
        unifiedAnalysisControl: true,
        analysisActions: ANALYSIS_ACTIONS,
      });
    }

    if (u.pathname === '/debug/analysis-tools') {
      return json(res, 200, {
        version: SERVER_VERSION,
        unifiedTools: analysisTools.map((x) => x.name),
        actions: ANALYSIS_ACTIONS,
      });
    }

    return proxy(req, res, raw);
  } catch (e) {
    console.error('v17_request_error', e?.stack || e?.message || e);
    return json(res, 500, { error: 'server_error', message: String(e?.message || e).slice(0, 280) });
  }
});

try {
  await waitForUpstream();
  server.listen(PORT, '0.0.0.0', () => console.log(`CHK Crypto Gateway v${SERVER_VERSION} unified Analyse MCP on :${PORT}`));
} catch (e) {
  console.error(e);
  child.kill('SIGTERM');
  process.exit(1);
}
