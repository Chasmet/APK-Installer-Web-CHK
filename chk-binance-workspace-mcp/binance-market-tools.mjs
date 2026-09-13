const BINANCE_BASE_URL = String(process.env.BINANCE_PUBLIC_BASE_URL || 'https://api.binance.com').replace(/\/$/, '');

const readAnn = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const binanceMarketTools = [
  {
    name: 'get_binance_market_snapshot',
    title: 'Snapshot marché Binance',
    description: 'Retourne les données publiques Binance Spot : ticker 24h, bid/ask, carnet, gros murs et bougies 1m/5m/15m/1h/4h/1d/1w. Aucune clé privée requise.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['symbol'], properties: {
        symbol: { type: 'string', description: 'Paire Binance, ex. RENDERUSDT ou BTCUSDC. Un symbole sans devise est complété par USDT.' },
        orderbook_limit: { type: 'integer', enum: [20, 50, 100, 500], default: 100 },
        candle_limit: { type: 'integer', minimum: 20, maximum: 200, default: 120 }
      }
    },
    annotations: readAnn
  },
  {
    name: 'get_binance_orderbook',
    title: 'Carnet Binance',
    description: 'Retourne le carnet public Binance Spot avec bid/ask, spread et plus gros murs classés par notionnel. Aucune clé privée requise.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['symbol'], properties: {
        symbol: { type: 'string', description: 'Paire Binance, ex. RENDERUSDT.' },
        limit: { type: 'integer', enum: [5, 10, 20, 50, 100, 500, 1000, 5000], default: 100 }
      }
    },
    annotations: readAnn
  }
];

export const binanceMarketToolNames = new Set(binanceMarketTools.map(t => t.name));

function normalizeSymbol(value) {
  const s = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{2,30}$/.test(s)) throw new Error('Symbole Binance invalide');
  const knownQuotes = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB', 'EUR'];
  return knownQuotes.some(q => s.endsWith(q)) ? s : `${s}USDT`;
}

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function normalizeBookRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    const price = num(row?.[0]);
    const quantity = num(row?.[1]);
    return { price, quantity, notionalQuote: price != null && quantity != null ? price * quantity : null };
  });
}

function largestWalls(rows, count = 10) {
  return [...rows]
    .filter(x => Number.isFinite(x.notionalQuote))
    .sort((a, b) => b.notionalQuote - a.notionalQuote)
    .slice(0, count);
}

function normalizeTicker(t) {
  return {
    symbol: t.symbol,
    lastPrice: num(t.lastPrice),
    priceChange: num(t.priceChange),
    priceChangePercent: num(t.priceChangePercent),
    weightedAvgPrice: num(t.weightedAvgPrice),
    openPrice: num(t.openPrice),
    highPrice: num(t.highPrice),
    lowPrice: num(t.lowPrice),
    volumeBase24h: num(t.volume),
    volumeQuote24h: num(t.quoteVolume),
    bidPrice: num(t.bidPrice),
    bidQty: num(t.bidQty),
    askPrice: num(t.askPrice),
    askQty: num(t.askQty),
    openTime: num(t.openTime),
    closeTime: num(t.closeTime),
    tradeCount: num(t.count)
  };
}

function normalizeKlines(rows) {
  return (Array.isArray(rows) ? rows : []).map(k => [
    num(k?.[0]), num(k?.[1]), num(k?.[2]), num(k?.[3]), num(k?.[4]), num(k?.[5]),
    num(k?.[6]), num(k?.[7]), num(k?.[8]), num(k?.[9]), num(k?.[10])
  ]);
}

async function binanceFetch(endpoint, params = {}) {
  const url = new URL(`${BINANCE_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  const r = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'chk-crypto-workspace-binance-market/1.0' },
    signal: AbortSignal.timeout(8000)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text || '{}'); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`Binance HTTP ${r.status}: ${data?.msg || data?.message || text.slice(0, 180)}`);
  return data;
}

async function getOrderbook(symbol, limit = 100) {
  const raw = await binanceFetch('/api/v3/depth', { symbol, limit });
  const bids = normalizeBookRows(raw.bids);
  const asks = normalizeBookRows(raw.asks);
  const bestBid = bids[0] || null;
  const bestAsk = asks[0] || null;
  return {
    symbol,
    source: 'Binance Spot public API',
    lastUpdateId: raw.lastUpdateId ?? null,
    bestBid,
    bestAsk,
    spread: bestBid?.price != null && bestAsk?.price != null ? bestAsk.price - bestBid.price : null,
    spreadPercent: bestBid?.price > 0 && bestAsk?.price != null ? ((bestAsk.price - bestBid.price) / bestBid.price) * 100 : null,
    largestBidWalls: largestWalls(bids),
    largestAskWalls: largestWalls(asks),
    bids,
    asks
  };
}

async function getMarketSnapshot(args = {}) {
  const symbol = normalizeSymbol(args.symbol);
  const orderbookLimit = [20, 50, 100, 500].includes(Number(args.orderbook_limit)) ? Number(args.orderbook_limit) : 100;
  const candleLimit = Math.max(20, Math.min(200, Number(args.candle_limit || 120)));
  const intervals = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
  const [tickerRaw, bookTickerRaw, orderbook, ...klinesRaw] = await Promise.all([
    binanceFetch('/api/v3/ticker/24hr', { symbol }),
    binanceFetch('/api/v3/ticker/bookTicker', { symbol }),
    getOrderbook(symbol, orderbookLimit),
    ...intervals.map(interval => binanceFetch('/api/v3/klines', { symbol, interval, limit: candleLimit }))
  ]);
  const candles = {};
  intervals.forEach((interval, i) => { candles[interval] = normalizeKlines(klinesRaw[i]); });
  return {
    symbol,
    source: 'Binance Spot public API',
    fetchedAt: new Date().toISOString(),
    ticker24h: normalizeTicker(tickerRaw),
    topOfBook: {
      bidPrice: num(bookTickerRaw.bidPrice), bidQty: num(bookTickerRaw.bidQty),
      askPrice: num(bookTickerRaw.askPrice), askQty: num(bookTickerRaw.askQty)
    },
    orderbook,
    candleFormat: ['openTime', 'open', 'high', 'low', 'close', 'volumeBase', 'closeTime', 'volumeQuote', 'trades', 'takerBuyBase', 'takerBuyQuote'],
    candles
  };
}

function ok(id, data, text) {
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], structuredContent: data } };
}

function fail(id, error) {
  const message = String(error?.message || error);
  return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }], structuredContent: { ok: false, error: message } } };
}

export async function handleBinanceMarketTool(msg, name, args = {}) {
  try {
    if (name === 'get_binance_orderbook') {
      const symbol = normalizeSymbol(args.symbol);
      const allowed = [5, 10, 20, 50, 100, 500, 1000, 5000];
      const limit = allowed.includes(Number(args.limit)) ? Number(args.limit) : 100;
      const data = await getOrderbook(symbol, limit);
      return ok(msg.id, data, `Carnet Binance ${symbol} récupéré (${data.bids.length} bids / ${data.asks.length} asks).`);
    }
    if (name === 'get_binance_market_snapshot') {
      const data = await getMarketSnapshot(args);
      return ok(msg.id, data, `Snapshot Binance ${data.symbol} récupéré avec ticker, carnet et 7 timeframes.`);
    }
    throw new Error('unknown_binance_market_tool');
  } catch (e) {
    return fail(msg.id, e);
  }
}
