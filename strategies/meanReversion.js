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

    // 2026-05-08 (4h timeframe): real oversold means RSI<30 on 4h chart —
    // a genuine multi-day capitulation, not noise. Tightened back from
    // RSI<42 (which produced 9/9 losses on 1-min). On 4h, RSI<30 is rare
    // and historically bounces ~55% of the time on majors.
    const oversold = ind.rsi < 30;
    const sharpDrop = dropAtr > 1.5;
    const belowMean = price < ind.emaSlow;
    const distFromMean = Math.abs(price - ind.emaSlow) / ind.atr; // in ATR units

    // Don't fight a sustained freefall. At 4h timeframe, 60 bars = 10 days.
    // -15% over 10 days = structural bear trend (not a dip), skip.
    const emaSlowSlope = (() => {
        const histPrices = history.map(h => h.price);
        const recent = histPrices[histPrices.length - 1];
        const old = histPrices[histPrices.length - 60] || histPrices[0];
        return (recent - old) / old;
    })();
    const cliffFalling = emaSlowSlope < -0.15;

    if (cliffFalling) return null;
    if (!belowMean) return null;        // mean reversion requires price below the mean
    if (!(oversold && sharpDrop)) return null;

    // --- Confidence components ---
    // Strong RSI oversold = stronger signal (4h regime, RSI<30 threshold)
    const rsiScore = clamp01((30 - ind.rsi) / 15); // 0 at RSI=30, 1 at RSI=15
    // Sharper drop = better mean-reversion candidate (extreme drops = falling knife)
    const dropScore = dropAtr <= 4.0
        ? clamp01((dropAtr - 1.5) / 2.5)        // 0 at 1.5×ATR, 1 at 4.0×ATR
        : clamp01(1 - (dropAtr - 4.0) / 3.0);   // taper after 4.0
    // Further from mean = bigger expected bounce (inverse of momentum logic)
    const meanScore = clamp01(distFromMean / 5.0); // 0 at mean, 1 at 5+ ATR away
    // Liquidity (allowlisted = 1)
    const liquidityScore = 1.0;

    const confidence = 0.30 * rsiScore
        + 0.30 * dropScore
        + 0.25 * meanScore
        + 0.15 * liquidityScore;

    // --- Expected edge (4h regime) ---
    // Target: bounce back toward EMA_slow (the mean we're reverting to).
    // On 4h chart, EMA_slow(60) is the 10-day average; reversion to it is meaningful.
    const targetMove = Math.max(0, ind.emaSlow - price);
    let targetPct = (targetMove / price) * 100;
    targetPct = Math.min(targetPct, config.EXITS.TAKE_PROFIT_PCT);
    targetPct = Math.max(targetPct, 4.0); // min 4% target — must clear friction with margin

    // Stop wider on 4h: 4h ATR can be 2-4%, so a 1.5% stop would be 1 ATR (whipsaw).
    const stopPct = config.EXITS.STOP_LOSS_PCT * 0.6; // 3% effective stop

    // Win prob: oversold reversions on majors at 4h timeframe historically 50-60%.
    let probWin = 0.50;
    if (rsiScore > 0.7) probWin += 0.05;   // RSI<22 = deep oversold
    if (meanScore > 0.7) probWin += 0.03;
    if (dropScore > 0.6 && dropScore < 1.0) probWin += 0.03;
    if (distFromMean > 4.0) probWin += 0.04;
    probWin = Math.min(0.65, probWin);

    const costPct = totalRoundTripCostPct();
    const expectedEdgePct = probWin * targetPct - (1 - probWin) * stopPct - costPct;

    // Require positive expected edge at 4h regime — no more "let early exits save us"
    // from negative-EV trades. Real signals on 4h have positive math.
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
