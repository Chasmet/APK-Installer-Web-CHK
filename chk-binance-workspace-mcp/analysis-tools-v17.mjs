export function createAnalysisExtension({ currentChart, enqueue, handleChartCall, result }) {
  const readAnn = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const writeAnn = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const noProps = { type: 'object', properties: {}, additionalProperties: false };
  const timeframes = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','12h','1d','3d','1w'];
  const actions = [
    'get_state','set_symbol','set_timeframe','zoom_in','zoom_out','pan_left','pan_right',
    'go_to_latest','reset_view','set_auto_scale','set_visible_range','set_indicators',
    'set_profile','scroll_analysis_view'
  ];

  const tools = [
    {
      name: 'get_analysis_access',
      title: 'Accès complet onglet Analyse',
      description: 'Retourne l’état réel du graphique CHK Crypto et les commandes MCP disponibles pour l’onglet Analyse.',
      inputSchema: noProps,
      annotations: readAnn,
    },
    {
      name: 'get_analysis_chart_state',
      title: 'État graphique Analyse',
      description: 'Lit le même graphique que celui affiché dans l’APK : paire, timeframe, viewport, indicateurs, dessins et données visibles.',
      inputSchema: noProps,
      annotations: readAnn,
    },
    {
      name: 'zoom_chart',
      title: 'Zoom graphique Analyse',
      description: 'Zoome ou dézoome directement le viewport réel du graphique CHK Crypto.',
      inputSchema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['in','out'] },
          steps: { type: 'integer', minimum: 1, maximum: 10 },
        },
        required: ['direction'],
        additionalProperties: false,
      },
      annotations: writeAnn,
    },
    {
      name: 'pan_chart',
      title: 'Déplacer graphique Analyse',
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
      annotations: writeAnn,
    },
    {
      name: 'set_indicator',
      title: 'Régler indicateur Analyse',
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
      annotations: writeAnn,
    },
    {
      name: 'scroll_analysis_view',
      title: 'Faire défiler Analyse',
      description: 'Pilote à distance la navigation verticale réelle de l’onglet Analyse et sa petite molette : haut, bas, début, fin ou position 0..1.',
      inputSchema: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up','down','top','bottom'] },
          pixels: { type: 'integer', minimum: 0, maximum: 10000 },
          position: { type: 'number', minimum: 0, maximum: 1 },
        },
        additionalProperties: false,
      },
      annotations: writeAnn,
    },
    {
      name: 'control_analysis',
      title: 'Piloter onglet Analyse',
      description: 'Commande unifiée : paire, timeframe, zoom, déplacement, Auto Scale, plage visible, profils, indicateurs et scroll vertical.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: actions },
          symbol: { type: 'string' },
          timeframe: { type: 'string', enum: timeframes },
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
      annotations: writeAnn,
    },
  ];

  const names = new Set(tools.map((t) => t.name));

  async function setIndicator(msg, a) {
    const indicator = String(a.indicator || '').toUpperCase();
    const enabled = a.enabled !== false;
    const period = Number(a.period || 0);
    const periods = Array.isArray(a.periods) ? a.periods : [];
    const out = {};
    if (indicator === 'MA') out.ma = periods.length ? periods : [period > 0 ? period : 7, 14, 28];
    else if (indicator === 'EMA') out.ema = periods.length ? periods : [period > 0 ? period : 9, 20, 50, 200];
    else if (indicator === 'RSI') out.rsi = period > 1 ? period : 14;
    else if (indicator === 'ATR') out.atr = period > 1 ? period : 14;
    else if (indicator === 'MACD') out.macd = enabled;
    else if (indicator === 'BOLLINGER') out.bollinger = enabled;
    else if (indicator === 'VOLUME') out.volume = enabled;
    else throw new Error('Indicateur invalide');
    return handleChartCall(msg, 'set_chart_indicators', out);
  }

  async function control(msg, a) {
    const action = String(a.action || '');
    switch (action) {
      case 'get_state': return handleChartCall(msg, 'get_chart_state', {});
      case 'set_symbol': return handleChartCall(msg, 'set_chart_symbol', { symbol: a.symbol });
      case 'set_timeframe': return handleChartCall(msg, 'set_chart_timeframe', { timeframe: a.timeframe });
      case 'zoom_in': return handleChartCall(msg, 'chart_zoom_in', {});
      case 'zoom_out': return handleChartCall(msg, 'chart_zoom_out', {});
      case 'pan_left': return handleChartCall(msg, 'chart_pan_left', { candles: a.candles || 20 });
      case 'pan_right': return handleChartCall(msg, 'chart_pan_right', { candles: a.candles || 20 });
      case 'go_to_latest': return handleChartCall(msg, 'chart_go_to_latest', {});
      case 'reset_view': return handleChartCall(msg, 'chart_reset_view', {});
      case 'set_auto_scale': return handleChartCall(msg, 'set_chart_auto_scale', { enabled: a.enabled !== false });
      case 'set_visible_range': return handleChartCall(msg, 'set_chart_visible_range', { visible_count: a.visible_count, offset_from_end: a.offset_from_end });
      case 'set_indicators': {
        const out = {};
        for (const k of ['ma','ema','volume','bollinger','rsi','macd','atr']) if (a[k] !== undefined) out[k] = a[k];
        return handleChartCall(msg, 'set_chart_indicators', out);
      }
      case 'set_profile': return handleChartCall(msg, 'set_chart_profile', { profile: a.profile });
      case 'scroll_analysis_view': {
        const args = {};
        if (a.direction) args.direction = a.direction;
        if (a.pixels !== undefined) args.pixels = a.pixels;
        if (a.position !== undefined) args.position = a.position;
        const queued = await enqueue('scroll_analysis_view', args);
        return result(msg.id, queued, 'Navigation verticale Analyse envoyée à l’APK.');
      }
      default: throw new Error('Action Analyse invalide');
    }
  }

  async function handle(msg, name, a) {
    if (name === 'get_analysis_chart_state') return handleChartCall(msg, 'get_chart_state', {});
    if (name === 'get_analysis_access') {
      const state = await currentChart();
      return result(msg.id, {
        ok: true,
        gatewayVersion: '17.1.0',
        exactTools: ['get_analysis_chart_state','set_chart_timeframe','zoom_chart','pan_chart','set_indicator','scroll_analysis_view'],
        actions,
        state,
      }, 'Accès MCP complet à l’onglet Analyse disponible.');
    }
    if (name === 'zoom_chart') {
      const direct = String(a.direction || '').toLowerCase() === 'out' ? 'chart_zoom_out' : 'chart_zoom_in';
      const steps = Math.max(1, Math.min(10, Number(a.steps || 1)));
      let out;
      for (let i = 0; i < steps; i += 1) out = await handleChartCall(msg, direct, {});
      return out;
    }
    if (name === 'pan_chart') {
      return handleChartCall(msg, String(a.direction || '').toLowerCase() === 'right' ? 'chart_pan_right' : 'chart_pan_left', {
        candles: Math.max(1, Math.min(500, Number(a.candles || 20))),
      });
    }
    if (name === 'set_indicator') return setIndicator(msg, a);
    if (name === 'scroll_analysis_view') {
      const args = {};
      if (a.direction) args.direction = a.direction;
      if (a.pixels !== undefined) args.pixels = Math.max(0, Math.min(10000, Number(a.pixels)));
      if (a.position !== undefined) args.position = Math.max(0, Math.min(1, Number(a.position)));
      if (!args.direction && args.position === undefined) args.direction = 'down';
      const queued = await enqueue('scroll_analysis_view', args);
      return result(msg.id, queued, 'Navigation verticale envoyée à la vraie vue Analyse CHK Crypto.');
    }
    if (name === 'control_analysis') return control(msg, a);
    throw new Error(`Analyse tool not handled: ${name}`);
  }

  return { tools, names, actions, handle };
}
