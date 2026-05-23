const config = require('../config');
const { TOKENS } = require('../tokens');
const marketData = require('../marketData');
const signalEngine = require('../signalEngine');
const whaleCluster = require('../signals/whaleCluster');

const NAME = 'MOMENTUM';

// Cost estimate for a round-trip (buy + sell).
// Uses EXPECTED_SLIPPAGE_PCT for edge calc (not the tx-protection buffer).
function totalRoundTripCostPct(sizeEur) {
    const feePct = 2 * config.COSTS.SWAP_FEE_PCT;
    const slippagePct = 2 * (config.COSTS.EXPECTED_SLIPPAGE_PCT || 0.10);
    const gasPct = (2 * config.COSTS.GAS_PER_TX_USD / sizeEur) * 100;
    return feePct + slippagePct + gasPct;
}

// Normalize a value into [0,1] via clamping.
const clamp01 = v => Math.max(0, Math.min(1, v));

// Per-token evaluation. Returns a Decision (action=ENTER) or null.
function evaluateToken(token) {
    const ind = marketData.computeIndicators(token.address);
    if (!ind) return null; // not enough data yet

    // Require data quality
    if (!ind.depthOk) return null;
    if (ind.samples < 70) return null;

    const price = ind.price;
    if (!price || price <= 0) return null;

    // --- Long-term trend filter (4h timeframe) ---
    // 30-bar slope = 30 × 4h = 5 days. Don't take long entries when the
    // 5-day trend is materially negative (-3% or more = real bearish swing).
    const history = marketData.getHistory(token.address);
    const histPrices = history.map(h => h.price);
    if (histPrices.length >= 30) {
        const old30 = histPrices[histPrices.length - 30];
        const recent = histPrices[histPrices.length - 1];
        const longTrendPct = ((recent - old30) / old30) * 100;
        if (longTrendPct < -3.0) return null; // 5-day downtrend > 3% blocks long entries
    }

    // --- Entry signals (4h timeframe — strict; signal noise is mostly gone) ---
    // EMAs at 4h are slow-moving and meaningful. Strict cross is real, no
    // tolerance band needed. RSI 50-cross on 4h is a multi-day momentum signal,
    // not noise. The "rsiRecovery" weak-signal entry is REMOVED — at 1-min it
    // produced 21/21 losses by entering on noise.
    const emaUp = ind.emaFast > ind.emaSlow;
    const trendUp = emaUp && ind.emaFastSlope > 0;
    const priorHigh = ind.rollingHigh15;

    const breakout = priorHigh !== null
        && price > priorHigh
        && trendUp;

    const rsiCrossedUp = ind.rsiPrev !== null && ind.rsiPrev < 50 && ind.rsi > 50;
    const pullback = price > ind.emaSlow
        && emaUp
        && rsiCrossedUp
        && ind.atr !== null
        && Math.abs(price - ind.emaFast) < 0.8 * ind.atr;

    if (!breakout && !pullback) return null;

    // 2026-05-24 HOT-RSI gate (backtest-derived default).
    // The breakthrough fix: blocks entries when RSI is already over-extended.
    // Before adding this, MOMENTUM bought at RSI 60-83 and got stopped out 70%
    // of the time. Backtest over 90d: this gate alone improves PnL by +€53
    // (from -€60 to -€7). At RSI≤55, win rate climbs from 27% to 41%.
    // Env-tunable for further experimentation: BT_MOM_MAX_RSI.
    const maxEntryRsi = parseFloat(process.env.BT_MOM_MAX_RSI || '55');
    if (ind.rsi > maxEntryRsi) return null;

    // --- Confidence components ---
    const trendStrength = ind.atr > 0
        ? clamp01((ind.emaFast - ind.emaSlow) / ind.atr)
        : 0;

    // Volume proxy: use rolling-high relative to rolling-low range as a proxy for activity
    const rangeActivity = ind.rollingHigh15 && ind.rollingLow15 && ind.rollingLow15 > 0
        ? clamp01((ind.rollingHigh15 - ind.rollingLow15) / ind.rollingLow15 / 0.03)
        : 0.5;

    const rsiRegime = ind.rsi >= 45 && ind.rsi <= 70
        ? 1.0
        : Math.max(0, 1 - Math.abs(55 - ind.rsi) / 30);

    const liquidityScore = 1.0; // allowlisted tokens have deep pools by definition

    const confidence = 0.35 * trendStrength
        + 0.25 * rangeActivity
        + 0.20 * rsiRegime
        + 0.20 * liquidityScore;

    // --- Expected edge (4h regime, post-cost) ---
    // TP=10%, SL=5%. Early-exit logic still cuts losers below nominal SL but
    // the longer grace periods (4h before checking) let trends develop.
    const cappedTarget = config.EXITS.TAKE_PROFIT_PCT;
    const effectiveStop = config.EXITS.STOP_LOSS_PCT * 0.55;

    // Prob-win for 4h momentum on majors. Academic benchmarks for trend-following
    // on majors at 4h: ~50% base rate. Bonuses for confirmed trend conditions.
    let probWin = 0.50;
    if (breakout) probWin += 0.05;
    if (rsiRegime > 0.8) probWin += 0.03;
    if (trendStrength > 0.7) probWin += 0.04;

    // Whale co-signal: large wallets accumulating = higher conviction
    const whaleSig = whaleCluster.getWhaleSignal(token.address);
    let whaleBoost = 0;
    if (whaleSig && whaleSig.direction === 'BUY') {
        whaleBoost = whaleSig.strengthScore * 0.05;
        probWin += whaleBoost;
    }

    probWin = Math.min(0.65, probWin);

    const intendedSize = (config.RISK.MIN_POSITION_EUR + config.RISK.MAX_POSITION_EUR) / 2;
    const costPct = totalRoundTripCostPct(intendedSize);

    // At TP=10, SL=2.75 effective, cost=0.97: probWin=0.55 → edge = +3.4%
    // probWin=0.50 → edge = +2.65%. Both genuinely positive on 4h timeframe.
    const expectedEdgePct = probWin * cappedTarget - (1 - probWin) * effectiveStop - costPct;

    // Tighter block — at 4h we want only positive-EV signals.
    if (expectedEdgePct <= 0) return null;

    const score = signalEngine.scoreDecision(expectedEdgePct, confidence);

    const reason = breakout
        ? `breakout above 15-bar high (4h); EMA↑; RSI ${ind.rsi.toFixed(0)}`
        : `pullback to EMA (4h); RSI cross↑ ${ind.rsi.toFixed(0)}`;

    return signalEngine.emptyDecision({
        action: 'ENTER',
        strategy: NAME,
        token: token.address,
        symbol: token.symbol,
        score,
        confidence,
        expectedEdgePct,
        stopLossPct: config.EXITS.STOP_LOSS_PCT,
        takeProfitPct: cappedTarget,
        signals: {
            momentum: {
                breakout,
                pullback,
                trendStrength,
                rangeActivity,
                rsi: ind.rsi,
                emaFast: ind.emaFast,
                emaSlow: ind.emaSlow,
                atr: ind.atr,
                whaleBoost: whaleBoost.toFixed(3),
                whalePressureUsd: whaleSig ? whaleSig.netPressureUsd.toFixed(0) : '0',
                price
            }
        },
        reason
    });
}

async function evaluate(ctx) {
    const { portfolio } = ctx;
    const openTokens = new Set(
        (portfolio.getOpenPositions() || portfolio.getPortfolio().positions || [])
            .map(p => p.token.toLowerCase())
    );

    const decisions = [];
    for (const token of TOKENS) {
        // Don't stack entries on tokens already held
        if (openTokens.has(token.address.toLowerCase())) continue;
        const d = evaluateToken(token);
        if (d) decisions.push(d);
    }
    return decisions;
}

module.exports = {
    name: NAME,
    evaluate,
    // exposed for tests
    evaluateToken,
    totalRoundTripCostPct
};
