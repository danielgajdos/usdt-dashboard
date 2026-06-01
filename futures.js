// Binance Futures SHADOW venue (paper mode).
//
// Runs the SAME proven long-only MOMENTUM strategy on tokens that have edge but
// no BSC liquidity (IO, TAO, DYDX, APT, PENGU) + SOL as an overlap control.
// Real Binance prices, simulated fills, perp cost model (0.14% round-trip) +
// real funding. No real money — purely tracks what it WOULD do so we can compare
// it side-by-side with the live DEX bot before deciding to go live.
//
// State persisted to /app/data/futuresPortfolio.json, independent of the DEX
// portfolio. Exposed via getState() for the dashboard's Futures section.

const fs = require('fs');
const https = require('https');
const config = require('./config');
const marketData = require('./marketData');
const momentum = require('./strategies/momentum');
const riskManager = require('./riskManager');
const { FUTURES_TOKENS } = require('./futuresTokens');

const STATE_PATH = process.env.FUTURES_STATE_PATH || '/app/data/futuresPortfolio.json';
const PAPER_START_EUR = 1000;       // clean paper bankroll for % tracking
const POSITION_EUR = 100;           // fixed notional per paper trade, 1x leverage
const MAX_CONCURRENT = 3;
const PERP_RT_COST = 0.0014;        // 0.14% round-trip (taker fee + tiny slippage)
const FUNDING_REFRESH_MS = 60 * 60 * 1000; // refresh funding rates hourly

let state = {
    mode: 'SHADOW',
    startEquity: PAPER_START_EUR,
    startTime: new Date().toISOString(),
    cash: PAPER_START_EUR,
    realizedPnl: 0,
    positions: [],   // { symbol, address, entryPrice, amountEur, stopLossPct, takeProfitPct, decisionScore, timestamp }
    history: [],     // closed paper trades
    snapshots: [],
    stats: { decisionsGen: 0, opened: 0 }
};

// Funding-rate cache: symbol -> { rates: [{t,rate}], ts }
const funding = new Map();
let logFn = () => {};

function _load() {
    try {
        if (fs.existsSync(STATE_PATH)) {
            const loaded = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
            state = { ...state, ...loaded };
        }
    } catch (e) { console.error('[futures] load failed:', e.message); }
}
function _save() {
    try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
    catch (e) { console.error('[futures] save failed:', e.message); }
}

function _getJSON(url) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: 8000 }, (res) => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function _refreshFunding(binanceSymbol) {
    const cached = funding.get(binanceSymbol);
    if (cached && Date.now() - cached.ts < FUNDING_REFRESH_MS) return cached.rates;
    const arr = await _getJSON(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${binanceSymbol}&limit=200`);
    const rates = Array.isArray(arr) ? arr.map(x => ({ t: x.fundingTime, rate: parseFloat(x.fundingRate) })) : [];
    funding.set(binanceSymbol, { rates, ts: Date.now() });
    return rates;
}
function _fundingSum(rates, t0, t1) {
    let s = 0;
    for (const r of rates) if (r.t >= t0 && r.t <= t1) s += r.rate;
    return s; // long pays this fraction of notional
}

// Register futures tokens with marketData so the indicator pipeline works.
async function init(log = console.log) {
    logFn = log;
    _load();
    for (const t of FUTURES_TOKENS) {
        marketData.registerPriceToken(t.address, t.binanceSymbol, t.decimals);
    }
    logFn(`[futures] SHADOW venue init — ${FUTURES_TOKENS.length} tokens: ${FUTURES_TOKENS.map(t => t.symbol).join(', ')} | paper equity €${state.cash.toFixed(2)}`, 'info');
}

// One evaluation cycle — called on the same cadence as the main bot, but the
// kline-gated price fetch + 4h bars mean it only acts a few times a day.
async function tick() {
    // 1. Refresh prices (kline path; provider unused for price-only tokens)
    await Promise.all(FUTURES_TOKENS.map(t => marketData.refreshPrice(null, t.address, t.decimals).catch(() => null)));

    // 2. Exits first
    for (let i = state.positions.length - 1; i >= 0; i--) {
        const pos = state.positions[i];
        const ind = marketData.computeIndicators(pos.address);
        const price = ind ? ind.price : marketData.getLastPrice(pos.address);
        if (!price) continue;
        const check = riskManager.shouldExit(pos, price, ind);
        if (!check.shouldExit) continue;
        await _closePaper(pos, price, check.reason);
        state.positions.splice(i, 1);
    }

    // 3. Entries — long-only momentum, same gate as the DEX bot
    if (state.positions.length < MAX_CONCURRENT) {
        for (const t of FUTURES_TOKENS) {
            if (state.positions.length >= MAX_CONCURRENT) break;
            if (state.positions.find(p => p.address === t.address)) continue;
            const token = { address: t.address, symbol: t.symbol, binanceSymbol: t.binanceSymbol };
            let decision;
            try { decision = momentum.evaluateToken(token); } catch { decision = null; }
            if (!decision) continue;
            state.stats.decisionsGen++;
            if (decision.score < config.SIGNAL.MIN_SCORE) continue;
            if (decision.expectedEdgePct < config.SIGNAL.MIN_EDGE_PCT_AFTER_COSTS) continue;
            _openPaper(t, decision);
        }
    }

    // 4. Snapshot equity periodically (cap list length)
    const eq = _equity();
    const last = state.snapshots[state.snapshots.length - 1];
    if (!last || Date.now() - new Date(last.time).getTime() > 5 * 60 * 1000) {
        state.snapshots.push({ time: new Date().toISOString(), equity: eq, pnl: state.realizedPnl });
        if (state.snapshots.length > 2000) state.snapshots.shift();
    }
    _save();
}

function _equity() {
    let openVal = 0;
    for (const p of state.positions) {
        const price = marketData.getLastPrice(p.address);
        if (price && p.entryPrice) openVal += p.amountEur * (price / p.entryPrice);
    }
    return state.cash + openVal;
}

function _openPaper(t, decision) {
    const price = marketData.getLastPrice(t.address);
    if (!price) return;
    // Entry-side cost is applied at close (full round-trip), so cash just moves to the position.
    state.cash -= POSITION_EUR;
    state.positions.push({
        symbol: t.symbol,
        binanceSymbol: t.binanceSymbol,
        address: t.address,
        entryPrice: price,
        amountEur: POSITION_EUR,
        initialInvestment: POSITION_EUR,
        amountTokens: POSITION_EUR / price,
        strategy: 'MOMENTUM',
        stopLossPct: decision.stopLossPct,
        takeProfitPct: decision.takeProfitPct,
        highWaterMark: price,
        decisionScore: decision.score,
        timestamp: new Date().toISOString()
    });
    state.stats.opened++;
    logFn(`[futures] 📄 PAPER ENTER ${t.symbol} @ ${price.toPrecision(6)} — score ${decision.score}, edge ${decision.expectedEdgePct.toFixed(2)}%`, 'info');
}

async function _closePaper(pos, price, reason) {
    const grossRet = (price - pos.entryPrice) / pos.entryPrice;   // long-only
    let netRet = grossRet - PERP_RT_COST;
    // Apply real funding over the hold window (long pays positive funding)
    try {
        const rates = await _refreshFunding(pos.binanceSymbol);
        const fs2 = _fundingSum(rates, new Date(pos.timestamp).getTime(), Date.now());
        netRet -= fs2;
    } catch {}
    const exitValue = pos.amountEur * (1 + netRet);
    const pnl = exitValue - pos.initialInvestment;
    state.cash += exitValue;
    state.realizedPnl += pnl;
    state.history.unshift({
        symbol: pos.symbol, strategy: 'MOMENTUM',
        entryTime: pos.timestamp, exitTime: new Date().toISOString(),
        entryPrice: pos.entryPrice, exitPrice: price,
        investment: pos.initialInvestment, exitValue,
        pnl, pnlPercent: netRet * 100, reason,
        heldHours: ((Date.now() - new Date(pos.timestamp).getTime()) / 3.6e6).toFixed(1)
    });
    if (state.history.length > 500) state.history.pop();
    const tag = pnl >= 0 ? '✓' : '✗';
    logFn(`[futures] 📄 PAPER ${tag} CLOSE ${pos.symbol} @ ${price.toPrecision(6)}: €${pnl.toFixed(2)} (${(netRet * 100).toFixed(2)}%) — ${reason}`, pnl >= 0 ? 'success' : 'error');
}

function getState() {
    const equity = _equity();
    const days = Math.max(1, (Date.now() - new Date(state.startTime).getTime()) / 864e5);
    return {
        mode: state.mode,
        startEquity: state.startEquity,
        equity,
        cash: state.cash,
        realizedPnl: state.realizedPnl,
        unrealizedPnl: equity - state.cash - state.positions.reduce((s, p) => s + p.amountEur, 0),
        totalReturnPct: ((equity - state.startEquity) / state.startEquity) * 100,
        positions: state.positions.map(p => {
            const price = marketData.getLastPrice(p.address);
            const pnlPct = price && p.entryPrice ? ((price - p.entryPrice) / p.entryPrice) * 100 : null;
            return { ...p, currentPrice: price, pnlPct, pnlEur: pnlPct != null ? p.amountEur * pnlPct / 100 : null };
        }),
        history: state.history.slice(0, 40),
        snapshots: state.snapshots.slice(-300),
        stats: state.stats,
        tokens: FUTURES_TOKENS.map(t => t.symbol)
    };
}

module.exports = { init, tick, getState };
