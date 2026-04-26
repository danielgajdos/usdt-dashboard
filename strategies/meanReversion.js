const config = require('../config');
const { TOKENS } = require('../tokens');
const marketData = require('../marketData');
const signalEngine = require('../signalEngine');

const NAME = 'MEAN_REVERSION';

const clamp01 = v => Math.max(0, Math.min(1, v));

// Use EXPECTED_SLIPPAGE (not the tx-protection buffer) for edge calculation.
// Gas is a fixed cost — always divide by MAX position to get the best-case pct.
function totalRoundTripCostPct() {
    const feePct = 2 * config.COSTS.SWAP_FEE_PCT;
    const slippagePct = 2 * (config.COSTS.EXPECTED_SLIPPAGE_PCT || 0.10);
    const gasPct = (2 * config.COSTS.GAS_PER_TX_USD / config.RISK.MAX_POSITION_EUR) * 100;
    return feePct + slippagePct + gasPct;
}

// Compute the recent drop in ATR units over the last N samples.
function recentDropAtr(history, atr, lookback = 5) {
    if (history.length < lookback + 1 || !atr || atr <= 0) return 0;
    const recent = history.slice(-lookback - 1);
    const peak = Math.max(...recent.map(h => h.price));
    const last = recent[recent.length - 1].price;
    return (peak - last) / atr;
}

function evaluateToken(token) {
    const ind = marketData.computeIndicators(token.address);
    if (!ind) return null;
    if (!ind.depthOk) return null;
    if (ind.samples < 70) return null;

    const price = ind.price;
    if (!price || price <= 0) return null;
    if (!ind.atr || ind.atr <= 0) return null;

    // --- Mean reversion entry conditions ---
    const history = marketData.getHistory(token.address);
    const dropAtr = recentDropAtr(history, ind.atr, 5);

    // Oversold + sharp recent drop. distFromMean is intentionally NOT a gate:
    // when RSI < 28 the EMA_slow barely moved, so distance is always large — that's
    // exactly the reversion setup we want. It feeds the scoring instead.
    const oversold = ind.rsi < 28;
    const sharpDrop = dropAtr > 2.5;
    const distFromMean = Math.abs(price - ind.emaSlow) / ind.atr; // in ATR units

    // Don't fight a sustained freefall: use a 60-bar window to distinguish a genuine
    // oversold dip (slope -10%) from a full capitulation collapse (slope -15%+).
    const emaSlowSlope = (() => {
        const histPrices = history.map(h => h.price);
        const recent = histPrices[histPrices.length - 1];
        const old = histPrices[histPrices.length - 60] || histPrices[0];
        return (recent - old) / old;
    })();
    const cliffFalling = emaSlowSlope < -0.15; // -15% over 60 bars = structural downtrend

    if (cliffFalling) return null;
    if (!(oversold && sharpDrop)) return null;

    // --- Confidence components ---
    // Stronger RSI oversold = stronger signal
    const rsiScore = clamp01((30 - ind.rsi) / 15); // 0 at RSI=30, 1 at RSI=15
    // Sharper drop = better mean reversion candidate (but extreme drops are dangerous)
    const dropScore = dropAtr <= 4.5
        ? clamp01((dropAtr - 2.5) / 2.0)        // 0 at 2.5×ATR, 1 at 4.5×ATR
        : clamp01(1 - (dropAtr - 4.5) / 3.0);   // taper after 4.5 (too extreme = catching falling knife)
    // Further from mean = bigger expected bounce (inverse of momentum logic)
    const meanScore = clamp01(distFromMean / 8.0); // 0 at mean, 1 at 8+ ATR away
    // Liquidity (allowlisted = 1)
    const liquidityScore = 1.0;

    const confidence = 0.30 * rsiScore
        + 0.30 * dropScore
        + 0.25 * meanScore
        + 0.15 * liquidityScore;

    // --- Expected edge ---
    // Target: full reversion to EMA_slow (that's the mean we're reverting to).
    const targetMove = Math.max(0, ind.emaSlow - price);
    let targetPct = (targetMove / price) * 100;
    targetPct = Math.min(targetPct, config.EXITS.TAKE_PROFIT_PCT); // cap at full TP
    targetPct = Math.max(targetPct, 4.0); // min target 4% (need to clear costs)

    // Stop: very tight — if the bounce doesn't start within a couple ATRs, it's failing
    const stopPct = Math.min(2.0, config.EXITS.STOP_LOSS_PCT * 0.4);

    // Win prob: oversold reversions historically ~52-58% on liquid mid-caps
    let probWin = 0.50;
    if (rsiScore > 0.7) probWin += 0.04;   // RSI < 19.5 = genuinely extreme
    if (meanScore > 0.7) probWin += 0.03;  // far from mean = bigger snap-back expected
    if (dropScore > 0.6 && dropScore < 1.0) probWin += 0.02; // sweet-spot drop magnitude
    if (distFromMean > 6.0) probWin += 0.05; // 6+ ATR below mean = rare, high-probability bounce
    probWin = Math.min(0.65, probWin);

    const costPct = totalRoundTripCostPct();

    const expectedEdgePct = probWin * targetPct - (1 - probWin) * stopPct - costPct;
    if (expectedEdgePct <= 0) return null;

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
        ttlSeconds: 10, // shorter TTL — reversion windows close fast
        signals: {
            meanReversion: {
                rsi: ind.rsi,
                dropAtr,
                distFromMean,
                emaFast: ind.emaFast,
                emaSlow: ind.emaSlow,
                price,
                atr: ind.atr
            }
        },
        reason: `oversold (RSI ${ind.rsi.toFixed(0)}); −${dropAtr.toFixed(1)}×ATR drop; ${distFromMean.toFixed(1)}×ATR below mean; target EMA_slow ${ind.emaSlow.toFixed(3)}`
    });
}

async function evaluate(ctx) {
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
