// Market-direction signal from Binance public ticker data (no API key needed).
//
// Uses price-action of BTC + ETH (the market bellwethers) over 1h and 24h to
// classify the macro bias as bullish / neutral / bearish, with confidence.
// This gates strategies that go long: don't buy breakouts during synchronized
// red days; favor MR bounces only when the broader market isn't capitulating.
//
// Why not CryptoPanic / news LLMs at this stage:
//   - free CryptoPanic tier requires a key + rate-limits aggressively
//   - LLM classification costs money per call
//   - price-action sentiment is more honest anyway: "what did smart money DO
//     in the last 24h" beats "what did Twitter say about it"
//
// Cache: 5 minutes per fetch. Cheap, no auth, no LLM.

const https = require('https');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = { ts: 0, value: null, error: null };

// Bellwethers — what BTC+ETH do is what the BSC bot's tokens will do (high beta)
const BELLWETHERS = ['BTCUSDT', 'ETHUSDT'];

function fetchJson(url, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// Binance 24hr ticker stats for a single symbol.
// Returns { priceChangePct, volume, lastPrice, openPrice } or null.
async function fetchTicker(symbol) {
    const j = await fetchJson(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
    if (!j || !j.priceChangePercent) return null;
    return {
        symbol,
        priceChangePct: parseFloat(j.priceChangePercent),
        volume: parseFloat(j.quoteVolume),
        lastPrice: parseFloat(j.lastPrice),
        openPrice: parseFloat(j.openPrice)
    };
}

// 1h ticker (last bar). Used to check if recent direction agrees with 24h.
async function fetch1hChange(symbol) {
    const arr = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=2`);
    if (!Array.isArray(arr) || arr.length < 2) return null;
    const bar = arr[arr.length - 2]; // last CLOSED 1h bar
    const open = parseFloat(bar[1]), close = parseFloat(bar[4]);
    if (!open || !close) return null;
    return ((close - open) / open) * 100;
}

// Compute the macro bias.
// Returns: { verdict: 'bullish'|'neutral'|'bearish', confidence: 0..1, details }
async function fetchMarketBias() {
    const [btc24, eth24, btc1h, eth1h] = await Promise.all([
        fetchTicker('BTCUSDT'), fetchTicker('ETHUSDT'),
        fetch1hChange('BTCUSDT'), fetch1hChange('ETHUSDT')
    ]);
    if (!btc24 || !eth24) return { verdict: 'neutral', confidence: 0, details: { error: 'fetch failed' } };

    // Average 24h move across the two bellwethers
    const avg24 = (btc24.priceChangePct + eth24.priceChangePct) / 2;
    const avg1h = (btc1h != null && eth1h != null) ? (btc1h + eth1h) / 2 : null;

    // Trend agreement: if 1h and 24h agree on direction, conviction is higher
    const agree = avg1h != null && Math.sign(avg1h) === Math.sign(avg24);

    let verdict, confidence;
    if (avg24 > 2.0) {           // strong up day
        verdict = 'bullish';
        confidence = Math.min(1, Math.abs(avg24) / 6.0); // saturate at 6% move
    } else if (avg24 < -2.0) {   // strong down day
        verdict = 'bearish';
        confidence = Math.min(1, Math.abs(avg24) / 6.0);
    } else if (avg24 > 0.5 && agree) {
        verdict = 'bullish'; confidence = 0.3;
    } else if (avg24 < -0.5 && agree) {
        verdict = 'bearish'; confidence = 0.3;
    } else {
        verdict = 'neutral'; confidence = 0;
    }

    return {
        verdict, confidence,
        details: {
            btc24h: btc24.priceChangePct, eth24h: eth24.priceChangePct, avg24h: avg24,
            btc1h, eth1h, avg1h, agree,
            lastUpdate: new Date().toISOString()
        }
    };
}

// Public API: cached, returns synchronously after first warmup.
async function getMarketBias() {
    const now = Date.now();
    if (cache.value && (now - cache.ts) < CACHE_TTL_MS) return cache.value;
    try {
        const v = await fetchMarketBias();
        cache.ts = now; cache.value = v; cache.error = null;
        return v;
    } catch (e) {
        cache.error = e.message;
        // Stale cache better than nothing
        return cache.value || { verdict: 'neutral', confidence: 0, details: { error: e.message } };
    }
}

// Convenience: simple boolean checks for strategies.
async function isMarketBearish(threshold = 0.4) {
    const b = await getMarketBias();
    return b.verdict === 'bearish' && b.confidence >= threshold;
}
async function isMarketBullish(threshold = 0.4) {
    const b = await getMarketBias();
    return b.verdict === 'bullish' && b.confidence >= threshold;
}

module.exports = {
    getMarketBias,
    isMarketBearish,
    isMarketBullish,
    _cache: cache  // exposed for tests
};
