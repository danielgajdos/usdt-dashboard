const config = require('../config');
const { TOKENS } = require('../tokens');
const marketData = require('../marketData');
const signalEngine = require('../signalEngine');

// RANGE: chop / mean-reversion-lite strategy.
//   Fires when a token is oscillating in a defined band and price is currently near
//   the bottom of that band.  Different from MEAN_REVERSION:
//     - Doesn't require RSI < 35 (works in neutral RSI territory)
//     - Doesn't require sharp drop (works on mild oscillations)
//     - Explicitly REQUIRES the absence of trend (slope check)
//   So this strategy fires on the days when MOMENTUM and MR are both silent.

const NAME = 'RANGE';

const clamp01 = v => Math.max(0, Math.min(1, v));

function totalRoundTripCostPct() {
    const feePct = 2 * config.COSTS.SWAP_FEE_PCT;
    const slippagePct = 2 * (config.COSTS.EXPECTED_SLIPPAGE_PCT || 0.10);
    const gasPct = (2 * config.COSTS.GAS_PER_TX_USD / config.RISK.MAX_POSITION_EUR) * 100;
    return feePct + slippagePct + gasPct;
}

function evaluateToken(token) {
    const ind = marketData.computeIndicators(token.address);
    if (!ind) return null;
    if (!ind.depthOk) return null;
    if (ind.samples < 70) return null;

    const price = ind.price;
    if (!price || price <= 0) return null;
    if (!ind.atr || ind.atr <= 0) return null;
    if (!ind.rollingHigh15 || !ind.rollingLow15) return null;

    // --- Range conditions ---
    // The 15-bar window is hardcoded by computeIndicators; with 1-min klines that's
    // a 15-minute lookback, which is appropriate for the 60-min MAX_HOLD setup.
    const rangePct = ((ind.rollingHigh15 - ind.rollingLow15) / price) * 100;

    // 2026-05-07: lowered min range from 1.5% to 0.8% — flat majors rarely
    // produce 1.5%+ 15-min bands. TP floor stays at 2.5% so trades still
    // need to clear friction; the marginal-EV math is acknowledged.
    if (rangePct < 0.8 || rangePct > 6.0) return null;

    // Position within the range: 0 = exactly at low, 1 = exactly at high.
    // Buy in the lower 40% (loosened from 30% for more entry opportunities).
    const rangePos = (price - ind.rollingLow15) / (ind.rollingHigh15 - ind.rollingLow15);
    if (rangePos > 0.40) return null;

    // Reject genuine trends — those should fire MOMENTUM, not RANGE.
    // 60-bar slope > 1.5% in either direction = trending, skip.
    const history = marketData.getHistory(token.address);
    const histPrices = history.map(h => h.price);
    const old = histPrices[histPrices.length - 60] || histPrices[0];
    const recent = histPrices[histPrices.length - 1];
    const trendAbsPct = Math.abs((recent - old) / old) * 100;
    if (trendAbsPct > 1.5) return null;

    // --- Confidence ---
    // Tighter to bottom of range = better entry
    const positionScore = clamp01(1 - rangePos / 0.40); // 1 at bottom, 0 at the 40% gate
    // Range size sweet spot: 1.5-4% (enough room for TP after costs, not too wide)
    const rangeScore = (rangePct >= 1.5 && rangePct <= 4.0)
        ? 1.0
        : (rangePct < 1.5
            ? clamp01((rangePct - 0.8) / 0.7)
            : clamp01((6.0 - rangePct) / 2.0));
    // Liquidity (allowlisted = 1)
    const liquidityScore = 1.0;

    const confidence = 0.45 * positionScore
        + 0.35 * rangeScore
        + 0.20 * liquidityScore;

    // --- Targets ---
    // Aim for the mid-upper portion of the range (60% from the low).  Don't target
    // the very top — that's how range trades fail when the band breaks down.
    const upperTarget = ind.rollingLow15 + 0.60 * (ind.rollingHigh15 - ind.rollingLow15);
    const targetMove = Math.max(0, upperTarget - price);
    let targetPct = (targetMove / price) * 100;
    targetPct = Math.min(targetPct, config.EXITS.TAKE_PROFIT_PCT);
    // Floor: must clear round-trip friction (~2.3% at €25) for the trade to make sense
    // on a winning outcome. 2.5% gives a thin but positive net win.
    targetPct = Math.max(targetPct, 2.5);

    // Stop: tight, just below the recent low.  Range break invalidates the thesis.
    const stopPct = 1.2;

    // ProbWin: range bounces on liquid majors hit at ~52-58% historically.
    let probWin = 0.55;
    if (rangePos < 0.15) probWin += 0.04; // very close to support = better entry
    if (rangeScore > 0.9) probWin += 0.02;
    if (rangePct >= 2.5) probWin += 0.02; // wider range = more headroom for TP
    probWin = Math.min(0.65, probWin);

    const costPct = totalRoundTripCostPct();
    const expectedEdgePct = probWin * targetPct - (1 - probWin) * stopPct - costPct;

    // RANGE is a marginal-EV strategy by design at €25 size — early-exit logic
    // is what brings it into positive territory in practice. Allow up to -2%
    // expected edge; the score gate (and confidence weighting) does the filtering.
    if (expectedEdgePct <= -2.0) return null;

    const score = signalEngine.scoreDecision(expectedEdgePct, confidence);

    return signalEngine.emptyDecision({
        action: 'ENTER',
        strategy: NAME,
        token: token.address,
        symbol: token.symbol,
        score,
        confidence,
        expectedEdgePct,
        stopLossPct: stopPct,
        takeProfitPct: targetPct,
        ttlSeconds: 10,
        signals: {
            range: {
                rangePct: parseFloat(rangePct.toFixed(2)),
                rangePos: parseFloat(rangePos.toFixed(2)),
                rollingHigh: ind.rollingHigh15,
                rollingLow: ind.rollingLow15,
                trendAbsPct: parseFloat(trendAbsPct.toFixed(2)),
                rsi: ind.rsi
            }
        },
        reason: `range buy: ${rangePct.toFixed(2)}% band, ${(rangePos * 100).toFixed(0)}% from low, target ${targetPct.toFixed(2)}%`
    });
}

async function evaluate(ctx) {
    if (!config.STRATEGIES.RANGE || !config.STRATEGIES.RANGE.enabled) return [];

    const { portfolio } = ctx;
    const openTokens = new Set(
        (portfolio.getOpenPositions() || [])
            .map(p => p.token.toLowerCase())
    );

    const decisions = [];
    for (const token of TOKENS) {
        if (openTokens.has(token.address.toLowerCase())) continue;
        const d = evaluateToken(token);
        if (d) decisions.push(d);
    }
    return decisions;
}

module.exports = {
    name: NAME,
    evaluate,
    evaluateToken,
    totalRoundTripCostPct
};
