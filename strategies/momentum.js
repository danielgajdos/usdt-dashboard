const config = require('../config');
const { TOKENS } = require('../tokens');
const marketData = require('../marketData');
const signalEngine = require('../signalEngine');

const NAME = 'MOMENTUM';

// Cost estimate for a round-trip (buy + sell).
// Used to translate raw target move into post-cost expected edge.
function totalRoundTripCostPct(sizeEur) {
    const feePct = 2 * config.COSTS.SWAP_FEE_PCT;          // 0.5%
    const slippagePct = 2 * config.COSTS.SLIPPAGE_BUFFER_PCT; // 2.0%
    const gasPct = (2 * config.COSTS.GAS_PER_TX_USD / sizeEur) * 100; // depends on size!
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

    // --- Entry signals ---
    const trendUp = ind.emaFast > ind.emaSlow && ind.emaFastSlope > 0;
    const priorHigh = ind.rollingHigh15;

    const breakout = priorHigh !== null
        && price > priorHigh
        && trendUp;

    const rsiCrossedUp = ind.rsiPrev !== null && ind.rsiPrev < 50 && ind.rsi > 50;
    const pullback = price > ind.emaSlow
        && ind.emaFast > ind.emaSlow
        && rsiCrossedUp
        && ind.atr !== null
        && Math.abs(price - ind.emaFast) < 0.5 * ind.atr;

    if (!breakout && !pullback) return null;

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

    // --- Expected edge (post-cost) ---
    // Target: 2.5 * ATR up; Stop: 1.2 * ATR down (on price)
    const targetPct = (2.5 * ind.atr / price) * 100;
    const stopPct = (1.2 * ind.atr / price) * 100;

    // Cap targets/stops into sensible bounds
    const cappedTarget = Math.min(targetPct, config.EXITS.TAKE_PROFIT_PCT * 1.5);
    const cappedStop = Math.min(stopPct, config.EXITS.STOP_LOSS_PCT);

    // Prob-win estimate: base 0.48 + small bonuses
    let probWin = 0.48;
    if (breakout) probWin += 0.04;
    if (rsiRegime > 0.8) probWin += 0.02;
    if (trendStrength > 0.7) probWin += 0.03;
    probWin = Math.min(0.58, probWin);

    // Use intended position size (mid of min/max) to estimate cost
    const intendedSize = (config.RISK.MIN_POSITION_EUR + config.RISK.MAX_POSITION_EUR) / 2;
    const costPct = totalRoundTripCostPct(intendedSize);

    const expectedEdgePct = probWin * cappedTarget - (1 - probWin) * cappedStop - costPct;

    if (expectedEdgePct <= 0) return null;

    const score = signalEngine.scoreDecision(expectedEdgePct, confidence);

    const reason = breakout
        ? `breakout above 15m high; EMA↑; RSI ${ind.rsi.toFixed(0)}`
        : `pullback to EMA; RSI cross↑ ${ind.rsi.toFixed(0)}`;

    return signalEngine.emptyDecision({
        action: 'ENTER',
        strategy: NAME,
        token: token.address,
        symbol: token.symbol,
        score,
        confidence,
        expectedEdgePct,
        stopLossPct: Math.min(cappedStop, config.EXITS.STOP_LOSS_PCT),
        takeProfitPct: Math.min(cappedTarget, config.EXITS.TAKE_PROFIT_PCT),
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
