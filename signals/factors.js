// Additional quantitative factors beyond EMA/RSI/ATR, drawn from the
// Vibe-Trading Alpha Zoo philosophy but selected for actual relevance to
// crypto majors at retail size.  All from free Binance public APIs.
//
// Each factor function returns a numeric score; -1 = strongly bearish,
// 0 = neutral, +1 = strongly bullish.  Strategies can fold them into
// their confidence calculation as additional inputs.
//
// Cache: 5 minutes per factor per symbol.

const https = require('https');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // key = factor:symbol → { ts, value }

function _get(key) {
    const e = cache.get(key);
    if (e && (Date.now() - e.ts) < CACHE_TTL_MS) return e.value;
    return null;
}
function _set(key, value) { cache.set(key, { ts: Date.now(), value }); }

function fetchJson(url, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// FACTOR 1 — Volume-weighted directional bias.
//   Last 6 1h bars (= last 6 hours).  Sum quote-volume on green bars vs red bars.
//   Ratio >> 1 = buyers in control; ratio << 1 = sellers in control.
//   Returns score in [-1, +1] mapped from log-ratio.
async function volumeBias(symbol) {
    const k = 'volBias:' + symbol;
    const cached = _get(k); if (cached !== null) return cached;
    const arr = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=7`);
    if (!Array.isArray(arr) || arr.length < 6) { _set(k, 0); return 0; }
    const bars = arr.slice(0, -1); // exclude current incomplete bar
    let greenVol = 0, redVol = 0;
    for (const b of bars) {
        const open = parseFloat(b[1]), close = parseFloat(b[4]);
        const qVol = parseFloat(b[7]); // quote-asset volume (USDT)
        if (close > open) greenVol += qVol;
        else if (close < open) redVol += qVol;
    }
    const totalVol = greenVol + redVol;
    if (totalVol === 0) { _set(k, 0); return 0; }
    // Log-ratio centered at 0
    const score = Math.max(-1, Math.min(1, Math.log((greenVol + 1) / (redVol + 1)) / 1.5));
    _set(k, score);
    return score;
}

// FACTOR 2 — Funding rate signal.
//   Binance Futures funding rate measures the premium longs pay to shorts.
//   Extreme positive (>0.05%) = crowded long, contrarian SHORT signal.
//   Extreme negative (<-0.05%) = capitulation, contrarian LONG signal.
//   Returns score in [-1, +1] where positive favors LONG entries.
async function fundingRateSignal(symbol) {
    const k = 'funding:' + symbol;
    const cached = _get(k); if (cached !== null) return cached;
    // Futures symbol differs for some pairs but for BTC/ETH/SOL it's the same
    const arr = await fetchJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=3`);
    if (!Array.isArray(arr) || arr.length === 0) { _set(k, 0); return 0; }
    // Average last 3 funding intervals (8h each = last 24h)
    const avg = arr.reduce((s, r) => s + parseFloat(r.fundingRate), 0) / arr.length;
    // Map: -0.05% funding → +1 (contrarian long), +0.05% → -1 (contrarian short)
    const score = Math.max(-1, Math.min(1, -avg / 0.0005));
    _set(k, score);
    return score;
}

// FACTOR 3 — Order-book imbalance.
//   Top 5 levels of bid vs ask.  Ratio > 1.5 = buy pressure, < 0.67 = sell.
//   Returns score in [-1, +1].
async function orderBookImbalance(symbol) {
    const k = 'obi:' + symbol;
    const cached = _get(k); if (cached !== null) return cached;
    const j = await fetchJson(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=5`);
    if (!j || !Array.isArray(j.bids) || !Array.isArray(j.asks)) { _set(k, 0); return 0; }
    const bidUsd = j.bids.reduce((s, [p, q]) => s + parseFloat(p) * parseFloat(q), 0);
    const askUsd = j.asks.reduce((s, [p, q]) => s + parseFloat(p) * parseFloat(q), 0);
    if (bidUsd === 0 && askUsd === 0) { _set(k, 0); return 0; }
    const score = Math.max(-1, Math.min(1, Math.log((bidUsd + 1) / (askUsd + 1)) / 1.0));
    _set(k, score);
    return score;
}

// FACTOR 4 — Cross-exchange decoupling (BTC-ETH ratio drift).
//   When BTC and ETH 24h moves DISAGREE strongly, it's a regime-shift signal.
//   Returns absolute value [0, 1]: high = "something unusual", strategies
//   should reduce position size or skip.
async function btcEthDecoupling() {
    const k = 'decouple';
    const cached = _get(k); if (cached !== null) return cached;
    const [btc, eth] = await Promise.all([
        fetchJson('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT'),
        fetchJson('https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDT')
    ]);
    if (!btc || !eth) { _set(k, 0); return 0; }
    const btcMove = parseFloat(btc.priceChangePercent);
    const ethMove = parseFloat(eth.priceChangePercent);
    // High beta of ETH vs BTC means a "normal" ratio is ETH ≈ 1.2 × BTC.
    // Anything wildly off — eg BTC -3% while ETH +2% — is unusual.
    const expected = btcMove * 1.2;
    const deviation = Math.abs(ethMove - expected);
    const score = Math.min(1, deviation / 5.0); // saturate at 5pp deviation
    _set(k, score);
    return score;
}

// Combined factor bundle — returns a single object with all four signals.
// Strategies call this once per evaluation and fold values into confidence.
async function getFactors(binanceSymbol) {
    const [vol, fund, obi, decouple] = await Promise.all([
        volumeBias(binanceSymbol),
        fundingRateSignal(binanceSymbol),
        orderBookImbalance(binanceSymbol),
        btcEthDecoupling()
    ]);
    return {
        volumeBias: vol,
        fundingSignal: fund,
        orderBookImbalance: obi,
        decouplingRisk: decouple,
        // Combined directional score (avg of first 3, with decoupling as a confidence haircut)
        combined: ((vol + fund + obi) / 3) * (1 - decouple * 0.5)
    };
}

module.exports = {
    volumeBias,
    fundingRateSignal,
    orderBookImbalance,
    btcEthDecoupling,
    getFactors
};
