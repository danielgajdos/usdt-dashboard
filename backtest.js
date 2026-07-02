#!/usr/bin/env node
// Historical-replay backtest harness for the strategy stack.
//
//   node backtest.js                                   # all 4 tokens, 90 days, all strategies
//   node backtest.js --token ETH --days 180
//   node backtest.js --strategy MEAN_REVERSION --size 100
//   node backtest.js --verbose                         # print per-trade entries/exits
//
// Replays 4h klines pulled fresh from Binance through signalEngine.scan(),
// applying the same gate, score formula, and cost model the live bot uses.
// No on-chain calls; no real money. Outputs win rate, PF, max DD, by-strategy
// breakdown.  The only mocking is: whaleCluster returns no signal (we have
// no historical whale data), and depth/honeypot are assumed OK on the curated
// majors universe.

const https = require('https');
const config = require('./config');
const { TOKENS, BY_SYMBOL } = require('./tokens');
const marketData = require('./marketData');
const signalEngine = require('./signalEngine');
const riskManager = require('./riskManager');

// Disable live factor API calls in backtest — they'd fetch CURRENT data which
// is meaningless when replaying historical bars.  Strategies that read factors
// see neutral zeros in this mode.
process.env.BT_NO_FACTORS = process.env.BT_NO_FACTORS || '1';

// Register strategies (mirrors index.js init order)
const momentum      = require('./strategies/momentum');
const meanReversion = require('./strategies/meanReversion');
const range         = require('./strategies/range');
const deepDip      = require('./strategies/deepDip');
signalEngine.register(momentum);
signalEngine.register(meanReversion);
signalEngine.register(range);
signalEngine.register(deepDip);

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i+1] : d; };
const TOKEN_SYM = arg('token', null);
const DAYS      = parseInt(arg('days', '90'));
const STRATEGY  = arg('strategy', null);
const SIZE_EUR  = parseFloat(arg('size', '100'));
const VERBOSE   = args.includes('--verbose');

// --universe futures replays the Binance Futures shadow venue's token list
// (futuresTokens.js) with perp-appropriate costs, giving that venue the same
// matched-window validation the DEX universe has.
const UNIVERSE = arg('universe', 'dex');
const { FUTURES_TOKENS } = require('./futuresTokens');
const universeTokens = UNIVERSE === 'futures' ? FUTURES_TOKENS : TOKENS;
const universeBySymbol = UNIVERSE === 'futures'
    ? Object.fromEntries(FUTURES_TOKENS.map(t => [t.symbol.toUpperCase(), t]))
    : BY_SYMBOL;
if (UNIVERSE === 'futures') console.log('Universe: FUTURES shadow venue (perp cost model)');

const SKIP_SYM = arg('skip', null); // comma-separated list of symbols to exclude
const skipSet = new Set((SKIP_SYM || '').split(',').filter(Boolean).map(s => s.toUpperCase()));
const tokensToTest = TOKEN_SYM
    ? [universeBySymbol[TOKEN_SYM.toUpperCase()]].filter(Boolean)
    : universeTokens.filter(t => t.binanceSymbol && !skipSet.has(t.symbol.toUpperCase()));
if (!tokensToTest.length) { console.error('Unknown or untradeable token'); process.exit(1); }
if (skipSet.size) console.log(`Skipping tokens: ${[...skipSet].join(',')}`);

if (STRATEGY) {
    const wanted = new Set(STRATEGY.toUpperCase().split(',').filter(Boolean));
    for (const k of Object.keys(config.STRATEGIES)) {
        config.STRATEGIES[k].enabled = wanted.has(k);
    }
    console.log(`Strategy filter: enabled ${[...wanted].join(',')}`);
}

// Sentiment gate: use historical BTC+ETH price action from the same backtest data
// to simulate the macro bias filter. Enabled by default; --no-sentiment disables.
const USE_SENTIMENT = !args.includes('--no-sentiment');
let btcBars = null, ethBars = null; // will be fetched once, shared across token runs

// Compute simulated bias for a given bar index in the BTC/ETH series.
// Mirrors signals/sentiment.js logic: avg of BTC + ETH 24h move (= 6 4h bars).
function simulatedBiasAt(barTimeMs) {
    if (!btcBars || !ethBars) return { verdict: 'neutral', confidence: 0 };
    function moveAt(bars, t) {
        // find the most recent bar at or before t, then look back 6 bars (24h)
        let i = bars.findIndex(b => b.t > t);
        if (i === -1) i = bars.length;
        i = i - 1;
        if (i < 6) return null;
        const now = bars[i].close;
        const day = bars[i - 6].close;
        return ((now - day) / day) * 100;
    }
    const btc24 = moveAt(btcBars, barTimeMs);
    const eth24 = moveAt(ethBars, barTimeMs);
    if (btc24 == null || eth24 == null) return { verdict: 'neutral', confidence: 0 };
    const avg24 = (btc24 + eth24) / 2;
    if (avg24 > 2.0) return { verdict: 'bullish', confidence: Math.min(1, Math.abs(avg24)/6.0) };
    if (avg24 < -2.0) return { verdict: 'bearish', confidence: Math.min(1, Math.abs(avg24)/6.0) };
    return { verdict: 'neutral', confidence: 0 };
}

// --- Mock the wallet time so riskManager.shouldExit ageMin math is correct ---
let mockNow = Date.now();
const origDateNow = Date.now;
Date.now = () => mockNow;

// --- Mock portfolio used by strategies ---
function makePortfolio(initialCashEur) {
    let cash = initialCashEur;
    const positions = [];
    return {
        getOpenPositions: () => positions,
        getPortfolio: () => ({
            cashBalance: cash,
            investedBalance: positions.reduce((s, p) => s + (p.initialInvestment || 0), 0),
            totalValue: cash + positions.reduce((s, p) => s + (p.amountTokens * (p._mark || p.entryPrice)), 0),
            positions, history: []
        }),
        cash: () => cash,
        adjustCash: d => { cash += d; },
        positions
    };
}

// --- Realistic cost model — matches live execution ---
// --slippage X overrides the per-side slippage % (default from config 0.10).
// Use it to validate thin-pool tokens (e.g. FIL) at honest friction.
// Futures universe: perp cost model (taker fee ~0.05%/side + ~0.02% slip, no gas
// ≈ 0.14% round-trip — matches futures.js PERP_RT_COST). DEX universe: on-chain costs.
const SWAP_FEE = UNIVERSE === 'futures' ? 0.0005 : config.COSTS.SWAP_FEE_PCT / 100;
const SLIP     = UNIVERSE === 'futures'
    ? 0.0002
    : (arg('slippage', null) !== null
        ? parseFloat(arg('slippage', '0.1'))
        : config.COSTS.EXPECTED_SLIPPAGE_PCT) / 100;
const GAS_USD  = UNIVERSE === 'futures' ? 0 : config.COSTS.GAS_PER_TX_USD;

function simBuy(price, sizeEur) {
    // amount in USDT → swap → tokens.  Slippage and fee eat the output.
    const usableUsd = sizeEur * (1 - SLIP) * (1 - SWAP_FEE);
    const tokens = usableUsd / price;
    return { tokens, cashOut: sizeEur + GAS_USD, entryPrice: sizeEur / tokens };
}
function simSell(price, tokens) {
    const grossUsd = tokens * price;
    const netUsd = grossUsd * (1 - SLIP) * (1 - SWAP_FEE);
    return { cashIn: netUsd - GAS_USD, exitPrice: netUsd / tokens };
}

async function fetchKlines(symbol, days) {
    const limit = Math.min(Math.ceil(days * 6) + 70, 1000); // +70 for warmup, capped at API max
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=4h&limit=${limit}`;
    return new Promise((resolve, reject) => {
        https.get(url, { timeout: 15000 }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const arr = JSON.parse(data);
                    if (!Array.isArray(arr)) return reject(new Error('Bad API response: ' + data.slice(0, 120)));
                    resolve(arr.map(r => ({
                        t: r[6], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5]
                    })));
                } catch (e) { reject(e); }
            });
        }).on('error', reject).on('timeout', () => reject(new Error('Binance API timeout')));
    });
}

async function runBacktest(token) {
    console.log(`\n=== ${token.symbol} (${token.binanceSymbol}) — ${DAYS}d @ 4h, size €${SIZE_EUR}, strategies: ${Object.entries(config.STRATEGIES).filter(([_,v])=>v.enabled).map(([k])=>k).join(',')} ===`);
    const bars = await fetchKlines(token.binanceSymbol, DAYS);
    if (bars.length < 70) {
        console.error(`  ! Only ${bars.length} bars, need 70 minimum`); return null;
    }

    const port = makePortfolio(1000); // €1000 starting equity for clean math
    const warmup = 70; // EMA60 + RSI14 buffer
    marketData.resetAll();
    marketData._seedHistoryBars(token.address, bars.slice(0, warmup));
    mockNow = bars[warmup - 1].t;

    let equityHigh = 1000, maxDD = 0;
    const trades = [];
    let decisionsGenerated = 0, decisionsExecuted = 0;

    for (let i = warmup; i < bars.length; i++) {
        const bar = bars[i];
        marketData._appendBar(token.address, bar);
        mockNow = bar.t;

        // --- Mark-to-market open positions for portfolio total + exit check ---
        const ind = marketData.computeIndicators(token.address);
        for (const p of port.positions) p._mark = bar.close;

        // --- Exit logic (priority order matches riskManager) ---
        for (let j = port.positions.length - 1; j >= 0; j--) {
            const pos = port.positions[j];
            const check = riskManager.shouldExit(pos, bar.close, ind);
            if (!check.shouldExit) continue;
            const sim = simSell(bar.close, pos.amountTokens);
            port.adjustCash(sim.cashIn);
            const pnl = sim.cashIn - pos.initialInvestment - GAS_USD; // include buy-side gas
            const pnlPct = (pnl / pos.initialInvestment) * 100;
            trades.push({
                symbol: token.symbol, strategy: pos.strategy,
                entryTime: pos.timestamp, exitTime: new Date(bar.t).toISOString(),
                entryPrice: pos.entryPrice, exitPrice: sim.exitPrice,
                investment: pos.initialInvestment, exitValue: sim.cashIn,
                pnl, pnlPct, reason: check.reason,
                heldHours: ((bar.t - new Date(pos.timestamp).getTime()) / 3.6e6).toFixed(1),
                score: pos.decisionScore
            });
            if (VERBOSE) {
                const tag = pnl >= 0 ? '✓' : '✗';
                console.log(`  ${tag} EXIT ${pos.symbol} ${pos.strategy} @ $${bar.close.toFixed(4)}: pnl=€${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) | ${check.reason}`);
            }
            port.positions.splice(j, 1);
        }

        // --- Position cap + cash reserve guards ---
        if (port.positions.length >= config.RISK.MAX_CONCURRENT_POSITIONS) continue;
        if (port.cash() < SIZE_EUR + config.RISK.MIN_CASH_RESERVE_EUR) continue;

        // --- Generate decisions ---
        const ctx = {
            portfolio: { getOpenPositions: port.getOpenPositions, getPortfolio: port.getPortfolio },
            log: () => {}, signer: null, provider: null
        };
        // Futures universe: mirror the live venue exactly — futures.js calls
        // momentum.evaluateToken(token) directly (long-only momentum, no other
        // strategies), because its synthetic addresses aren't in tokens.js and
        // signalEngine.scan would never see them.
        let decisions;
        if (UNIVERSE === 'futures') {
            const d = momentum.evaluateToken({ address: token.address, symbol: token.symbol, binanceSymbol: token.binanceSymbol });
            decisions = d ? [d] : [];
        } else {
            decisions = await signalEngine.scan(ctx);
        }
        decisionsGenerated += decisions.length;

        // Sentiment gate (mirror of production logic in index.js)
        let bias = null;
        if (USE_SENTIMENT) {
            bias = simulatedBiasAt(bar.t);
            if (bias.verdict === 'bearish' && bias.confidence >= 0.4) {
                if (VERBOSE && decisions.length > 0) {
                    console.log(`  ✗ SENTIMENT BLOCK ${decisions.length} decisions @ $${bar.close.toFixed(4)} (bias: ${bias.verdict}, conf ${bias.confidence.toFixed(2)})`);
                }
                continue;
            }
        }

        for (const d of decisions) {
            d.sizeEur = Math.min(SIZE_EUR, config.RISK.MAX_POSITION_EUR);
            if (d.score < config.SIGNAL.MIN_SCORE) continue;
            if (d.expectedEdgePct < config.SIGNAL.MIN_EDGE_PCT_AFTER_COSTS) continue;
            if (port.positions.find(p => p.token.toLowerCase() === d.token.toLowerCase())) continue;

            const sim = simBuy(bar.close, d.sizeEur);
            port.adjustCash(-sim.cashOut);
            port.positions.push({
                strategy: d.strategy, token: d.token, symbol: d.symbol,
                amountEur: d.sizeEur, initialInvestment: d.sizeEur,
                entryPrice: sim.entryPrice, amountTokens: sim.tokens,
                stopLossPct: d.stopLossPct, takeProfitPct: d.takeProfitPct,
                timestamp: new Date(bar.t).toISOString(),
                highWaterMark: sim.entryPrice, decisionScore: d.score
            });
            decisionsExecuted++;
            if (VERBOSE) {
                console.log(`  → ENTER ${d.strategy} @ $${bar.close.toFixed(4)}: score=${d.score} edge=${(d.expectedEdgePct||0).toFixed(2)}% | ${(d.reason||'').slice(0,80)}`);
            }
            break; // one entry per bar across all strategies
        }

        // Mark-to-market drawdown tracking
        const equity = port.cash() + port.positions.reduce((s, p) => s + p.amountTokens * bar.close, 0);
        equityHigh = Math.max(equityHigh, equity);
        maxDD = Math.max(maxDD, (equityHigh - equity) / equityHigh);
    }

    // Force-close any remaining at last bar
    const lastClose = bars[bars.length - 1].close;
    for (const pos of port.positions) {
        const sim = simSell(lastClose, pos.amountTokens);
        port.adjustCash(sim.cashIn);
        const pnl = sim.cashIn - pos.initialInvestment - GAS_USD;
        trades.push({
            symbol: token.symbol, strategy: pos.strategy,
            entryTime: pos.timestamp, exitTime: new Date(bars[bars.length-1].t).toISOString(),
            entryPrice: pos.entryPrice, exitPrice: sim.exitPrice,
            investment: pos.initialInvestment, exitValue: sim.cashIn,
            pnl, pnlPct: (pnl / pos.initialInvestment) * 100,
            reason: 'end-of-backtest mark', heldHours: '?'
        });
    }

    // --- Summary ---
    const wins = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
    const winRate = trades.length > 0 ? wins.length / trades.length : 0;
    const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const finalEquity = port.cash();

    console.log(`--- ${token.symbol} summary (${DAYS}d, ${decisionsGenerated} decisions generated, ${decisionsExecuted} executed) ---`);
    console.log(`Trades:        ${trades.length}  (${wins.length}W / ${losses.length}L)`);
    console.log(`Win rate:      ${(winRate * 100).toFixed(1)}%`);
    console.log(`Total PnL:     €${totalPnl.toFixed(2)}  (final equity €${finalEquity.toFixed(2)} from €1000 start)`);
    console.log(`Avg win:       €${wins.length ? (grossWin / wins.length).toFixed(2) : '0.00'}`);
    console.log(`Avg loss:      €${losses.length ? (-grossLoss / losses.length).toFixed(2) : '0.00'}`);
    console.log(`Profit factor: ${pf.toFixed(2)}`);
    console.log(`Max drawdown:  ${(maxDD * 100).toFixed(2)}%`);

    const byStrat = {};
    for (const t of trades) {
        if (!byStrat[t.strategy]) byStrat[t.strategy] = { n: 0, win: 0, pnl: 0 };
        byStrat[t.strategy].n++;
        if (t.pnl > 0) byStrat[t.strategy].win++;
        byStrat[t.strategy].pnl += t.pnl;
    }
    if (Object.keys(byStrat).length) {
        console.log('By strategy:');
        for (const [k, v] of Object.entries(byStrat)) {
            console.log(`  ${k.padEnd(20)} ${String(v.n).padStart(3)} trades  ${((v.win/v.n)*100).toFixed(0).padStart(3)}% win  €${v.pnl.toFixed(2).padStart(8)}`);
        }
    }
    return { token: token.symbol, trades, totalPnl, winRate, pf, maxDD, decisionsGenerated, decisionsExecuted };
}

(async () => {
    // Pre-fetch BTC + ETH klines once for the sentiment-simulator
    if (USE_SENTIMENT) {
        console.log(`Pre-fetching BTCUSDT + ETHUSDT for sentiment gate (${DAYS}d)...`);
        btcBars = await fetchKlines('BTCUSDT', DAYS);
        ethBars = await fetchKlines('ETHUSDT', DAYS);
    }
    const results = [];
    for (const t of tokensToTest) {
        try {
            const r = await runBacktest(t);
            if (r) results.push(r);
        } catch (e) {
            console.error(`  ! ${t.symbol} failed:`, e.message);
        }
    }
    if (results.length > 1) {
        console.log('\n=== AGGREGATE ===');
        const totalTrades = results.reduce((s, r) => s + r.trades.length, 0);
        const totalPnl = results.reduce((s, r) => s + r.totalPnl, 0);
        const totalWins = results.reduce((s, r) => s + r.trades.filter(t => t.pnl > 0).length, 0);
        const totalGen = results.reduce((s, r) => s + r.decisionsGenerated, 0);
        const totalExec = results.reduce((s, r) => s + r.decisionsExecuted, 0);
        console.log(`Decisions generated: ${totalGen}, executed: ${totalExec}`);
        console.log(`Total trades:        ${totalTrades}`);
        console.log(`Total PnL:           €${totalPnl.toFixed(2)}`);
        console.log(`Combined win rate:   ${totalTrades ? (100 * totalWins / totalTrades).toFixed(1) : 0}% (${totalWins}/${totalTrades})`);
    }
    Date.now = origDateNow;
    process.exit(0);
})().catch(e => { Date.now = origDateNow; console.error('FATAL:', e); process.exit(1); });
