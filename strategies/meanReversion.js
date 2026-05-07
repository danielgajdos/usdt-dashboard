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

    // 2026-05-07 (2nd relaxation): on the flat majors universe, RSI rarely
    // touches 35 either (best seen: 37 on CAKE, 38 on ETH). Loosened further
    // to fire on milder dips — early-exit logic catches the bad ones quickly.
    const oversold = ind.rsi < 42;
    const sharpDrop = dropAtr > 0.8;
    const belowMean = price < ind.emaSlow;
    const distFromMean = Math.abs(price - ind.emaSlow) / ind.atr; // in ATR units

    // Don't fight a sustained freefall: use a 60-bar window to distinguish a genuine
    // oversold dip from a structural collapse.
    const emaSlowSlope = (() => {
        const histPrices = history.map(h => h.price);
        const recent = histPrices[histPrices.length - 1];
        const old = histPrices[histPrices.length - 60] || histPrices[0];
        return (recent - old) / old;
    })();
    const cliffFalling = emaSlowSlope < -0.05; // -5% over 60 bars = structural downtrend

    if (cliffFalling) return null;
    if (!belowMean) return null;        // mean reversion requires price below the mean
    if (!(oversold && sharpDrop)) return null;

    // --- Confidence components ---
    // Stronger RSI oversold = stronger signal (rebased to looser threshold)
    const rsiScore = clamp01((42 - ind.rsi) / 25); // 0 at RSI=42, 1 at RSI=17
    // Sharper drop = better mean reversion candidate (but extreme drops are dangerous)
    const dropScore = dropAtr <= 4.0
        ? clamp01((dropAtr - 0.8) / 3.2)        // 0 at 0.8×ATR, 1 at 4.0×ATR
        : clamp01(1 - (dropAtr - 4.0) / 3.0);   // taper after 4.0 (extreme = catching falling knife)
    // Further from mean = bigger expected bounce (inverse of momentum logic)
    const meanScore = clamp01(distFromMean / 5.0); // 0 at mean, 1 at 5+ ATR away
    // Liquidity (allowlisted = 1)
    const liquidityScore = 1.0;

    const confidence = 0.30 * rsiScore
        + 0.30 * dropScore
        + 0.25 * meanScore
        + 0.15 * liquidityScore;

    // --- Expected edge ---
    // Target: bounce back toward EMA_slow (the mean we're reverting to).
    const targetMove = Math.max(0, ind.emaSlow - price);
    let targetPct = (targetMove / price) * 100;
    targetPct = Math.min(targetPct, config.EXITS.TAKE_PROFIT_PCT); // cap at full TP
    targetPct = Math.max(targetPct, 1.5); // min 1.5% — small bounces still tradeable

    // Stop: tight — if the bounce doesn't start quickly, it's failing
    const stopPct = Math.min(1.5, config.EXITS.STOP_LOSS_PCT * 0.6);

    // Win prob: oversold reversions historically ~52-58% on liquid majors;
    // base raised for the looser threshold (more, but slightly weaker, signals).
    let probWin = 0.55;
    if (rsiScore > 0.7) probWin += 0.04;   // RSI < 21 = strong oversold
    if (meanScore > 0.7) probWin += 0.03;  // far from mean = bigger snap-back expected
    if (dropScore > 0.6 && dropScore < 1.0) probWin += 0.02; // sweet-spot drop magnitude
    if (distFromMean > 4.0) probWin += 0.04; // 4+ ATR below mean = rare, high-prob bounce
    probWin = Math.min(0.70, probWin);

    const costPct = totalRoundTripCostPct();

    const expectedEdgePct = probWin * targetPct - (1 - probWin) * stopPct - costPct;
    // Allow marginally-negative edge — early-exit logic in riskManager caps realized
    // losses well below nominal stop, so the live distribution beats the static math.
    // 2026-05-07: relaxed from -1.0 → -2.0 to match RANGE strategy on this flat universe.
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
