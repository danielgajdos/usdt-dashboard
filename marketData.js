const https = require('https');
const { ethers } = require('ethers');
const { quote, sellPath } = require('./dexRegistry');
const { WBNB, USDT, BY_ADDRESS } = require('./tokens');

// Price history ring buffer per token, plus indicator calculators.
//
// Price source strategy (in order of preference):
//   1. Binance REST API (api.binance.com) — if token has binanceSymbol set.
//      Binance prices reflect real trading on the CEX and update every tick even
//      when the BSC PCS V2 pool is quiet (most V2 pools migrated to V3 in 2024+).
//   2. PancakeSwap V2 on-chain quote — fallback for tokens without a Binance listing.
//
// Depth check (is there enough BSC DEX liquidity to actually execute?) runs
// on-chain every DEPTH_CHECK_INTERVAL ticks — much less often than the price feed
// to avoid spamming the RPC.

const BUFFER_SIZE = 180;               // 15 min @ 5s
const QUOTE_NOTIONAL_USD = 25;
const DEPTH_CHECK_INTERVAL = 30;       // re-check on-chain depth every 30 ticks (~150s)

// Map<tokenAddressLower, {history: [], lastUpdate: 0, lastDepthOk: true, depthCheckCount: 0}>
const state = new Map();

function _init(address) {
    const key = address.toLowerCase();
    if (!state.has(key)) {
        state.set(key, { history: [], lastUpdate: 0, lastDepthOk: true, depthCheckCount: 0 });
    }
    return state.get(key);
}

// Fetch spot price from Binance REST API. Free, no auth, always up-to-date.
// Returns float USD price or null on any failure.
function fetchBinancePrice(binanceSymbol) {
    return new Promise((resolve) => {
        const req = https.get(
            `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(binanceSymbol)}`,
            { timeout: 3000 },
            (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const p = parseFloat(json.price);
                        resolve(isNaN(p) || p <= 0 ? null : p);
                    } catch { resolve(null); }
                });
            }
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// Check BSC DEX liquidity depth via on-chain quote.
// Returns { price, depthOk } or null on failure.
async function fetchOnChainPrice(provider, tokenAddress, decimals) {
    try {
        const oneUnit = ethers.parseUnits('1', decimals);
        const out = await quote(provider, 'PCS_V2', sellPath(tokenAddress), oneUnit);
        if (out === null || out === 0n) return null;
        const price = parseFloat(ethers.formatUnits(out, 18));

        // Depth: quote a $25 buy; if effective price deviates >3% from spot → thin pool
        const notional = ethers.parseUnits(String(QUOTE_NOTIONAL_USD), 18);
        const buyOut = await quote(provider, 'PCS_V2', [USDT, WBNB, tokenAddress], notional);
        let depthOk = true;
        if (buyOut !== null && buyOut > 0n) {
            const tokensGot = parseFloat(ethers.formatUnits(buyOut, decimals));
            const effectivePrice = QUOTE_NOTIONAL_USD / tokensGot;
            const deviation = Math.abs(effectivePrice - price) / price;
            depthOk = deviation < 0.03;
        }
        return { price, depthOk };
    } catch {
        return null;
    }
}

// Main price refresh — called every tick from index.js.
// Uses Binance price (if available) for the ring buffer; checks on-chain depth periodically.
async function refreshPrice(provider, tokenAddress, decimals = 18) {
    const key = tokenAddress.toLowerCase();
    const s = _init(tokenAddress);
    const token = BY_ADDRESS[key];
    const binanceSymbol = token ? token.binanceSymbol : null;

    let price = null;
    let depthOk = s.lastDepthOk; // inherit last known depth until next check

    if (binanceSymbol) {
        // Primary: Binance CEX price
        price = await fetchBinancePrice(binanceSymbol);
        // Periodic on-chain depth check
        s.depthCheckCount++;
        if (s.depthCheckCount % DEPTH_CHECK_INTERVAL === 1 || !s.history.length) {
            const onChain = await fetchOnChainPrice(provider, tokenAddress, decimals);
            if (onChain !== null) {
                s.lastDepthOk = onChain.depthOk;
                depthOk = onChain.depthOk;
                // If on-chain and Binance differ by >5%, prefer on-chain (likely delisting)
                if (price && Math.abs(onChain.price - price) / price > 0.05) {
                    price = onChain.price;
                }
            }
        }
    } else {
        // Fallback: on-chain quote (tokens not on Binance)
        const onChain = await fetchOnChainPrice(provider, tokenAddress, decimals);
        if (onChain === null) return null;
        price = onChain.price;
        depthOk = onChain.depthOk;
        s.lastDepthOk = depthOk;
    }

    if (!price || price <= 0) return null;

    const entry = { t: Date.now(), price, depthOk };
    s.history.push(entry);
    if (s.history.length > BUFFER_SIZE) s.history.shift();
    s.lastUpdate = entry.t;
    return entry;
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
