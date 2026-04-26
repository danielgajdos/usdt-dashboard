const { ethers } = require('ethers');
const { quote, sellPath } = require('./dexRegistry');
const { WBNB, USDT } = require('./tokens');

// Price history ring buffer per token, plus indicator calculators.
// Prices are stored as floats (USD per token, quoted via 1-token sell path).

const BUFFER_SIZE = 180;               // 15 min @ 5s
const QUOTE_NOTIONAL_USD = 25;         // quote using €25 notional so slippage estimate is realistic

// Map<tokenAddressLower, {history: Array<{t, price, liquidityUsd}>, lastUpdate: number}>
const state = new Map();

function _init(address) {
    const key = address.toLowerCase();
    if (!state.has(key)) {
        state.set(key, { history: [], lastUpdate: 0 });
    }
    return state.get(key);
}

// Fetch spot price for `token`: quote 1 full token selling → USDT, return float.
// Also fetches liquidity proxy: quote for QUOTE_NOTIONAL_USD buy size to detect depth.
async function refreshPrice(provider, tokenAddress, decimals = 18) {
    try {
        const oneUnit = ethers.parseUnits('1', decimals);
        const out = await quote(provider, 'PCS_V2', sellPath(tokenAddress), oneUnit);
        if (out === null || out === 0n) return null;

        const price = parseFloat(ethers.formatUnits(out, 18)); // USDT has 18 decimals on BSC

        // Liquidity proxy: quote a $25 buy → how many tokens? Reverse that to effective price.
        // If effective price deviates >3% from spot, pool is thin.
        const notional = ethers.parseUnits(String(QUOTE_NOTIONAL_USD), 18);
        const buyOut = await quote(provider, 'PCS_V2', [USDT, WBNB, tokenAddress], notional);
        let depthOk = true;
        if (buyOut !== null && buyOut > 0n) {
            const tokensGot = parseFloat(ethers.formatUnits(buyOut, decimals));
            const effectivePrice = QUOTE_NOTIONAL_USD / tokensGot;
            const deviation = Math.abs(effectivePrice - price) / price;
            depthOk = deviation < 0.03;
        }

        const entry = {
            t: Date.now(),
            price,
            depthOk
        };

        const s = _init(tokenAddress);
        s.history.push(entry);
        if (s.history.length > BUFFER_SIZE) s.history.shift();
        s.lastUpdate = entry.t;

        return entry;
    } catch {
        return null;
    }
}

function getHistory(tokenAddress) {
    const s = _init(tokenAddress);
    return s.history;
}

function getLastPrice(tokenAddress) {
    const s = _init(tokenAddress);
    const last = s.history[s.history.length - 1];
    return last ? last.price : null;
}

// --- Indicators ---

function ema(values, period) {
    if (values.length < period) return null;
    const k = 2 / (period + 1);
    let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
        e = values[i] * k + e * (1 - k);
    }
    return e;
}

function emaSeries(values, period) {
    if (values.length < period) return [];
    const k = 2 / (period + 1);
    const out = [];
    let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    out.push(e);
    for (let i = period; i < values.length; i++) {
        e = values[i] * k + e * (1 - k);
        out.push(e);
    }
    return out;
}

// Wilder RSI
function rsi(values, period = 14) {
    if (values.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
        const d = values[i] - values[i - 1];
        if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period;
    loss /= period;
    for (let i = period + 1; i < values.length; i++) {
        const d = values[i] - values[i - 1];
        const g = d > 0 ? d : 0;
        const l = d < 0 ? -d : 0;
        gain = (gain * (period - 1) + g) / period;
        loss = (loss * (period - 1) + l) / period;
    }
    if (loss === 0) return 100;
    const rs = gain / loss;
    return 100 - 100 / (1 + rs);
}

// RSI over a window, returning last N values (to detect cross-through-50).
function rsiSeries(values, period = 14) {
    const out = [];
    for (let i = period + 1; i <= values.length; i++) {
        const slice = values.slice(0, i);
        out.push(rsi(slice, period));
    }
    return out;
}

// ATR approximation on close-only prices (true range collapses to abs diff).
function atr(prices, period = 14) {
    if (prices.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < prices.length; i++) {
        trs.push(Math.abs(prices[i] - prices[i - 1]));
    }
    // Wilder smoothing
    let a = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trs.length; i++) {
        a = (a * (period - 1) + trs[i]) / period;
    }
    return a;
}

function rollingHigh(prices, window) {
    if (prices.length === 0) return null;
    const slice = prices.slice(-window);
    return Math.max(...slice);
}

function rollingLow(prices, window) {
    if (prices.length === 0) return null;
    const slice = prices.slice(-window);
    return Math.min(...slice);
}

// Convenience: compute all indicators for a token.
function computeIndicators(tokenAddress) {
    const history = getHistory(tokenAddress);
    if (history.length < 65) return null; // need enough data for EMA_slow(60)

    const prices = history.map(h => h.price);

    const emaFastSeries = emaSeries(prices, 20);
    const emaSlowSeries = emaSeries(prices, 60);
    const rsiSer = rsiSeries(prices, 14);

    const emaFast = emaFastSeries[emaFastSeries.length - 1];
    const emaSlow = emaSlowSeries[emaSlowSeries.length - 1];
    const emaFastSlope = emaFastSeries.length >= 4
        ? (emaFast - emaFastSeries[emaFastSeries.length - 4])
        : 0;

    return {
        price: prices[prices.length - 1],
        emaFast,
        emaSlow,
        emaFastSlope,
        rsi: rsiSer[rsiSer.length - 1],
        rsiPrev: rsiSer.length >= 4 ? rsiSer[rsiSer.length - 4] : null,
        atr: atr(prices, 14),
        rollingHigh15: rollingHigh(prices.slice(0, -1), 180),
        rollingLow15: rollingLow(prices.slice(0, -1), 180),
        depthOk: history[history.length - 1].depthOk,
        samples: history.length
    };
}

function resetAll() {
    state.clear();
}

// TEST-ONLY helper. Seeds the history ring buffer with synthetic prices so
// strategies can be unit-tested without a live provider. Each price becomes
// an entry with depthOk=true and timestamps spaced 5 seconds apart.
function _seedTestHistory(tokenAddress, prices, { depthOk = true, intervalMs = 5000 } = {}) {
    const s = _init(tokenAddress);
    s.history = [];
    const now = Date.now();
    const startT = now - prices.length * intervalMs;
    for (let i = 0; i < prices.length; i++) {
        s.history.push({
            t: startT + i * intervalMs,
            price: prices[i],
            depthOk
        });
    }
    s.lastUpdate = s.history[s.history.length - 1]?.t || now;
}

module.exports = {
    refreshPrice,
    getHistory,
    getLastPrice,
    computeIndicators,
    ema,
    rsi,
    atr,
    rollingHigh,
    rollingLow,
    resetAll,
    _seedTestHistory,
    BUFFER_SIZE
};
