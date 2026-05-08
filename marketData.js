const https = require('https');
const { ethers } = require('ethers');
const { quote, sellPath, bestQuote } = require('./dexRegistry');
const { WBNB, USDT, BY_ADDRESS } = require('./tokens');

// Per-token venue cache populated by the depth check. Read by execution.js to
// pick the right router. Map<tokenAddrLower, { venue, fee }>.
const TOKEN_VENUE = new Map();
function getVenue(tokenAddress) {
    return TOKEN_VENUE.get(tokenAddress.toLowerCase()) || null;
}

// Price history ring buffer per token, plus indicator calculators.
//
// Price source strategy (in order of preference):
//   1. Binance REST API klines (1-minute OHLCV bars) — if token has binanceSymbol set.
//      Each entry in the ring buffer is the CLOSE price of a closed 1-min candle.
//      This gives indicators real price movement instead of the noise we saw with
//      /ticker/price (which returned identical "last trade" values for many seconds
//      on low-volume mid-cap tokens).
//   2. PancakeSwap V2 on-chain quote — fallback for tokens without a Binance listing.
//
// Tick loop calls refreshPrice every 5s. For Binance-backed tokens we only hit the
// API when a new 1-min candle has closed (~once/min/token). On boot, we backfill
// the entire buffer in a single call, so the bot is ready in seconds, not hours.
//
// Depth check (is there enough BSC DEX liquidity to actually execute?) runs
// on-chain every DEPTH_CHECK_INTERVAL ticks — much less often than the price feed
// to avoid spamming the RPC.

// 2026-05-08: TIMEFRAME PIVOT — switched klines from 1-minute to 4-hour bars.
// 1-minute scalping had no edge after 21/21 losses. 4h swing trading targets
// multi-day moves where retail TA actually has historical edge.
const BUFFER_SIZE = 180;               // 180 × 4h bars = 30 days of history
const QUOTE_NOTIONAL_USD = 25;
const DEPTH_CHECK_INTERVAL = 30;       // re-check on-chain depth every 30 ticks (~150s)
const KLINE_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4-hour bars
const KLINE_INTERVAL_STR = '4h';       // Binance API param

// Map<tokenAddressLower, {history: [], lastUpdate: 0, lastDepthOk: true, depthCheckCount: 0, lastKlineCloseTime: 0}>
const state = new Map();

function _init(address) {
    const key = address.toLowerCase();
    if (!state.has(key)) {
        state.set(key, {
            history: [],
            lastUpdate: 0,
            lastDepthOk: true,
            depthCheckCount: 0,
            lastKlineCloseTime: 0
        });
    }
    return state.get(key);
}

// Fetch the most recent N closed 1-minute klines from Binance.
// Returns array of { closeTime, open, high, low, close } or null on failure.
// Note: Binance kline rows are [openTime, open, high, low, close, volume, closeTime, ...]
// The LAST element of the returned array is the currently-open (in-progress) bar
// whose closeTime is in the future — we filter it out so only closed bars are used.
function fetchBinanceKlines(binanceSymbol, limit = 5) {
    return new Promise((resolve) => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol)}&interval=${KLINE_INTERVAL_STR}&limit=${limit}`;
        const req = https.get(url, { timeout: 4000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const arr = JSON.parse(data);
                    if (!Array.isArray(arr)) return resolve(null);
                    const now = Date.now();
                    const bars = arr
                        .map(r => ({
                            closeTime: r[6],
                            open: parseFloat(r[1]),
                            high: parseFloat(r[2]),
                            low: parseFloat(r[3]),
                            close: parseFloat(r[4])
                        }))
                        .filter(b =>
                            b.closeTime < now &&     // skip the open/in-progress bar
                            !isNaN(b.close) && b.close > 0
                        );
                    resolve(bars);
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// Check BSC DEX liquidity depth via on-chain quote.
// Tries V2 multi-hop AND V3 single-hop, picks whichever has better depth.
// Caches the chosen venue in TOKEN_VENUE so execution.js routes via the same
// DEX (otherwise we'd quote on V3 then try to swap on V2 → no liquidity).
async function fetchOnChainPrice(provider, tokenAddress, decimals) {
    try {
        const oneUnit = ethers.parseUnits('1', decimals);
        // Sell quote: 1 token → USDT (best venue)
        const sellBest = await bestQuote(provider, tokenAddress, USDT, oneUnit);
        if (!sellBest) return null;
        const price = parseFloat(ethers.formatUnits(sellBest.amountOut, 18));

        // Buy quote: $QUOTE_NOTIONAL_USD → token (same direction as a real entry)
        const notional = ethers.parseUnits(String(QUOTE_NOTIONAL_USD), 18);
        const buyBest = await bestQuote(provider, USDT, tokenAddress, notional);
        let depthOk = true;
        let executionVenue = sellBest.venue;
        let executionFee = sellBest.fee || null;

        if (buyBest && buyBest.amountOut > 0n) {
            const tokensGot = parseFloat(ethers.formatUnits(buyBest.amountOut, decimals));
            const effectivePrice = QUOTE_NOTIONAL_USD / tokensGot;
            const deviation = Math.abs(effectivePrice - price) / price;
            depthOk = deviation < 0.03;
            // Prefer the buy venue for execution since we open positions buy-first
            executionVenue = buyBest.venue;
            executionFee = buyBest.fee || null;
        }

        // Cache venue+fee for execution.js to use on the actual swap.
        TOKEN_VENUE.set(tokenAddress.toLowerCase(), { venue: executionVenue, fee: executionFee });

        return { price, depthOk, venue: executionVenue, fee: executionFee };
    } catch {
        return null;
    }
}

// Main price refresh — called every tick (5s) from index.js.
// For Binance-backed tokens: fetches 1-min klines only when a new bar has closed.
// On first call, backfills the full buffer in one shot so we have history immediately.
async function refreshPrice(provider, tokenAddress, decimals = 18) {
    const key = tokenAddress.toLowerCase();
    const s = _init(tokenAddress);
    const token = BY_ADDRESS[key];
    const binanceSymbol = token ? token.binanceSymbol : null;

    let depthOk = s.lastDepthOk; // inherit last known depth until next check

    if (binanceSymbol) {
        // First call: backfill the buffer with BUFFER_SIZE recent closed klines so
        // indicators are warm immediately instead of needing 65 minutes of wall time.
        if (s.history.length === 0) {
            const bars = await fetchBinanceKlines(binanceSymbol, BUFFER_SIZE);
            if (bars && bars.length) {
                for (const b of bars) {
                    s.history.push({ t: b.closeTime, price: b.close, high: b.high, low: b.low, depthOk });
                }
                s.lastKlineCloseTime = bars[bars.length - 1].closeTime;
                s.lastUpdate = Date.now();
            }
        } else {
            // Steady-state: only hit the API when the next 1-min bar should have closed.
            const nextExpectedClose = s.lastKlineCloseTime + KLINE_INTERVAL_MS;
            if (Date.now() >= nextExpectedClose + 1000 /* small safety margin */) {
                const bars = await fetchBinanceKlines(binanceSymbol, 5);
                if (bars && bars.length) {
                    for (const b of bars) {
                        if (b.closeTime > s.lastKlineCloseTime) {
                            s.history.push({ t: b.closeTime, price: b.close, high: b.high, low: b.low, depthOk });
                            if (s.history.length > BUFFER_SIZE) s.history.shift();
                            s.lastKlineCloseTime = b.closeTime;
                            s.lastUpdate = Date.now();
                        }
                    }
                }
            }
        }

        // Periodic on-chain depth check (gated independently of price fetches).
        s.depthCheckCount++;
        if (s.depthCheckCount % DEPTH_CHECK_INTERVAL === 1) {
            const onChain = await fetchOnChainPrice(provider, tokenAddress, decimals);
            if (onChain !== null) {
                s.lastDepthOk = onChain.depthOk;
                // Patch depthOk on the most recent bar so computeIndicators sees fresh state.
                if (s.history.length) {
                    s.history[s.history.length - 1].depthOk = onChain.depthOk;
                }
            }
        }
        return s.history[s.history.length - 1] || null;
    }

    // Fallback: on-chain quote (tokens not on Binance) — preserve original 5s polling.
    const onChain = await fetchOnChainPrice(provider, tokenAddress, decimals);
    if (onChain === null) return null;
    const entry = { t: Date.now(), price: onChain.price, depthOk: onChain.depthOk };
    s.lastDepthOk = onChain.depthOk;
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
        rollingHigh15: rollingHigh(prices.slice(0, -1), 15),
        rollingLow15: rollingLow(prices.slice(0, -1), 15),
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
    getVenue,            // execution.js looks this up to route V2 vs V3
    ema,
    rsi,
    atr,
    rollingHigh,
    rollingLow,
    resetAll,
    _seedTestHistory,
    BUFFER_SIZE
};
