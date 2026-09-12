import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM_PORT = Number(process.env.V17_UPSTREAM_PORT || (PORT + 10));
const SERVER_VERSION = '17.1.0';
const MCP_LINK_TOKEN = String(process.env.MCP_LINK_TOKEN || '');
const BYBIT_API_KEY = String(process.env.BYBIT_API_KEY || '').trim();
const CHK_INTERNAL_TOKEN = String(process.env.CHK_INTERNAL_TOKEN || '');
const EDGE_URL = String(process.env.SUPABASE_EDGE_URL || '');
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

const ACCOUNT_FINGERPRINT = BYBIT_API_KEY
  ? crypto.createHash('sha256').update(BYBIT_API_KEY).digest('hex')
  : '';

function constantEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function validLegacyMcpPath(p) {
  return !!MCP_LINK_TOKEN && p.startsWith('/mcp/') && constantEqual(p.slice(5), MCP_LINK_TOKEN);
}
function isMcpPath(p) {
  return p === '/mcp' || validLegacyMcpPath(p);
}

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

function chartUrl() {
  if (!EDGE_URL) throw new Error('SUPABASE_EDGE_URL missing');
  const u = new URL(EDGE_URL);
  u.pathname = u.pathname.replace(/\/chk-binance-workspace-latest\/?$/, '/chk-chart-control');
  return u.toString();
}

async function chartBridge(payload) {
  if (!CHK_INTERNAL_TOKEN || !ACCOUNT_FINGERPRINT) throw new Error('Chart command bridge not configured');
  const r = await fetch(chartUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chk-internal-token': CHK_INTERNAL_TOKEN,
      accept: 'application/json',
      'user-agent': 'chk-crypto-workspace-v17.1',
    },
    body: JSON.stringify({ ...payload, accountFingerprint: ACCOUNT_FINGERPRINT }),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text || '{}'); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`chk-chart-control ${r.status}: ${data?.error || data?.message || text.slice(0, 180)}`);
  return data;
}

async function enqueue(op, args = {}) {
  return chartBridge({ action: 'enqueue_command', command: { op, args } });
}

const READ_ANN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE_ANN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const NO_PROPS = { type: 'object', properties: {}, additionalProperties: false };
const TIMEFRAMES = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d','3d','1w'];

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
  'scroll_analysis_view',
];

const analysisTools = [
  {
    name: 'get_analysis_access',
    title: 'Accès complet onglet Analyse',
    description: 'Retourne l’état réel du graphique CHK Crypto et tous les contrôles MCP disponibles dans l’onglet Analyse.',
    inputSchema: NO_PROPS,
    annotations: READ_ANN,
  },
  {
    name: 'get_analysis_chart_state',
    title: 'État du graphique Analyse',
    description: 'Lit exactement le graphique actuellement synchronisé avec l’onglet Analyse : paire, timeframe, viewport, indicateurs, dessins et données visibles.',
    inputSchema: NO_PROPS,
    annotations: READ_ANN,
  },
  {
    name: 'zoom_chart',
    title: 'Zoomer le graphique Analyse',
    description: 'Zoome ou dézoome le viewport réel du graphique CHK Crypto.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['in','out'] },
        steps: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    annotations: WRITE_ANN,
  },
  {
    name: 'pan_chart',
    title: 'Déplacer le graphique Analyse',
    description: 'Déplace horizontalement le vrai graphique vers l’historique ou vers le présent.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['left','right'] },
        candles: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['direction'],
      additionalProperties: false,
    },
    annotations: WRITE_ANN,
  },
  {
    name: 'set_indicator',
    title: 'Régler un indicateur Analyse',
    description: 'Active, désactive ou règle MA, EMA, RSI, MACD, ATR, Bollinger ou Volume sur le graphique réel.',
    inputSchema: {
      type: 'object',
      properties: {
        indicator: { type: 'string', enum: ['MA','EMA','RSI','MACD','ATR','BOLLINGER','VOLUME'] },
        enabled: { type: 'boolean' },
        period: { type: 'integer', minimum: 1, maximum: 500 },
        periods: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 500 }, maxItems: 12 },
      },
      required: ['indicator'],
      additionalProperties: false,
    },
    annotations: WRITE_ANN,
  },
  {
    name: 'scroll_analysis_view',
    title: 'Faire défiler l’onglet Analyse',
    description: 'Pilote à distance la même navigation verticale que la petite molette de l’APK : haut, bas, top, bottom ou position normalisée 0..1.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up','down','top','bottom'] },
        pixels: { type: 'integer', minimum: 0, maximum: 10000 },
        position: { type: 'number', minimum: 0, maximum: 1 },
      },
      additionalProperties: false,
    },
    annotations: WRITE_ANN,
  },
  {
    name: 'control_analysis',
    title: 'Piloter l’onglet Analyse',
    description: 'Commande unifiée du graphique réel CHK Crypto : paire, timeframe, zoom, déplacement, plage visible, Auto Scale, profil, indicateurs et navigation verticale.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ANALYSIS_ACTIONS },
        symbol: { type: 'string' },
        timeframe: { type: 'string', enum: TIMEFRAMES },
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
        direction: { type: 'string' },
        pixels: { type: 'integer', minimum: 0, maximum: 10000 },
        position: { type: 'number', minimum: 0, maximum: 1 },
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
    case 'scroll_analysis_view': {
      const out = {};
      if (args.direction) out.direction = args.direction;
      if (args.pixels !== undefined) out.pixels = args.pixels;
      if (args.position !== undefined) out.position = args.position;
      const queued = await enqueue('scroll_analysis_view', out);
      return result(msg.id, queued, 'Navigation verticale Analyse envoyée à l’APK.');
    }
    default:
      throw new Error('Action Analyse non gérée');
  }
}

async function handleSetIndicator(msg, args) {
  const indicator = String(args.indicator || '').toUpperCase();
  const enabled = args.enabled !== false;
  const period = Number(args.period || 0);
  const periods = Array.isArray(args.periods) ? args.periods : [];
  const out = {};
  if (indicator === 'MA') out.ma = periods.length ? periods : [period > 0 ? period : 7, 14, 28];
  else if (indicator === 'EMA') out.ema = periods.length ? periods : [period > 0 ? period : 9, 20, 50, 200];
  else if (indicator === 'RSI') out.rsi = period > 1 ? period : 14;
  else if (indicator === 'ATR') out.atr = period > 1 ? period : 14;
  else if (indicator === 'MACD') out.macd = enabled;
  else if (indicator === 'BOLLINGER') out.bollinger = enabled;
  else if (indicator === 'VOLUME') out.volume = enabled;
  else throw new Error('Indicateur invalide');
  return upstreamToolCall(msg.id, 'set_chart_indicators', out);
}

async function handleOne(msg, requestPath = '/mcp') {
  if (msg?.method === 'initialize') {
    const out = await upstreamRpc(msg);
    if (out?.result) {
      out.result.serverInfo = { name: 'chk-crypto-workspace', version: SERVER_VERSION };
      out.result.capabilities = out.result.capabilities || {};
      out.result.capabilities.tools = { ...(out.result.capabilities.tools || {}), listChanged: true };
      out.result.instructions = `${out.result.instructions || ''} CHK Crypto v17.1 expose sur /mcp et /mcp/<token> les contrôles Analyse exacts : get_analysis_chart_state, set_chart_timeframe, zoom_chart, pan_chart, set_indicator et scroll_analysis_view. Ces commandes pilotent le graphique et la navigation verticale réellement affichés dans l APK. Aucun ordre réel sans confirmation utilisateur.`.trim();
    }
    console.log(`[MCP v17.1] initialize path=${requestPath}`);
    return out;
  }

  if (msg?.method === 'tools/list') {
    const out = await upstreamRpc(msg);
    const tools = Array.isArray(out?.result?.tools) ? out.result.tools : [];
    for (const tool of analysisTools) {
      if (!tools.some((x) => x?.name === tool.name)) tools.push(tool);
    }
    if (out?.result) out.result.tools = tools;
    console.log(`[MCP v17.1] tools/list path=${requestPath} count=${tools.length} analysisAliases=${analysisTools.length}`);
    return out;
  }

  if (msg?.method !== 'tools/call') return upstreamRpc(msg);
  const name = String(msg?.params?.name || '');
  const args = msg?.params?.arguments || {};

  if (name === 'get_analysis_access' || name === 'get_analysis_chart_state') {
    const stateOut = await upstreamToolCall(msg.id, 'get_chart_state', {});
    if (name === 'get_analysis_chart_state') return stateOut;
    const state = structured(stateOut);
    return result(
      msg.id,
      {
        ok: true,
        gatewayVersion: SERVER_VERSION,
        actions: ANALYSIS_ACTIONS,
        exactTools: ['get_analysis_chart_state','set_chart_timeframe','zoom_chart','pan_chart','set_indicator','scroll_analysis_view'],
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

  if (name === 'zoom_chart') {
    const dir = String(args.direction || '').toLowerCase();
    const tool = dir === 'out' ? 'chart_zoom_out' : 'chart_zoom_in';
    const steps = Math.max(1, Math.min(10, Number(args.steps || 1)));
    let out;
    for (let i = 0; i < steps; i += 1) out = await upstreamToolCall(msg.id, tool, {});
    return out;
  }

  if (name === 'pan_chart') {
    const dir = String(args.direction || '').toLowerCase();
    return upstreamToolCall(msg.id, dir === 'right' ? 'chart_pan_right' : 'chart_pan_left', {
      candles: Math.max(1, Math.min(500, Number(args.candles || 20))),
    });
  }

  if (name === 'set_indicator') return handleSetIndicator(msg, args);

  if (name === 'scroll_analysis_view') {
    const out = {};
    if (args.direction) out.direction = args.direction;
    if (args.pixels !== undefined) out.pixels = Math.max(0, Math.min(10000, Number(args.pixels)));
    if (args.position !== undefined) out.position = Math.max(0, Math.min(1, Number(args.position)));
    if (!out.direction && out.position === undefined) out.direction = 'down';
    const queued = await enqueue('scroll_analysis_view', out);
    return result(msg.id, queued, 'Navigation verticale envoyée à la vraie vue Analyse CHK Crypto.');
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

    if (u.pathname.startsWith('/mcp/') && !validLegacyMcpPath(u.pathname)) {
      return json(res, 403, { error: 'mcp_forbidden' });
    }

    if (isMcpPath(u.pathname) && req.method === 'POST') {
      let parsed;
      try {
        parsed = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      const out = Array.isArray(parsed)
        ? await Promise.all(parsed.map((x) => handleOne(x, u.pathname)))
        : await handleOne(parsed, u.pathname);
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
        legacyTokenizedMcpCompat: true,
        remoteAnalysisScroll: true,
        exactAnalysisTools: ['get_analysis_chart_state','set_chart_timeframe','zoom_chart','pan_chart','set_indicator','scroll_analysis_view'],
        analysisActions: ANALYSIS_ACTIONS,
      });
    }

    if (u.pathname === '/debug/analysis-tools') {
      return json(res, 200, {
        version: SERVER_VERSION,
        tools: analysisTools.map((x) => x.name),
        exactTools: ['get_analysis_chart_state','set_chart_timeframe','zoom_chart','pan_chart','set_indicator','scroll_analysis_view'],
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
  server.listen(PORT, '0.0.0.0', () => console.log(`CHK Crypto Gateway v${SERVER_VERSION} exact Analyse MCP on :${PORT}`));
} catch (e) {
  console.error(e);
  child.kill('SIGTERM');
  process.exit(1);
}
