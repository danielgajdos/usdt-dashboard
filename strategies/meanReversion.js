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
    // 2026-05-15: After 3 post-pivot MR trades all lost via "reversion failed
    // (RSI 23, still below mean)", we now demand THREE confirmations before
    // catching the knife:
    //   FIX 1 — RSI turn-up (was oversold within ~12h, now rising past 30)
    //   FIX 2 — short-term trend not aggressively bearish (30-bar slope > -3%)
    //   FIX 3 — structural support: price near a tested 7-day low
    const history = marketData.getHistory(token.address);
    const histPrices = history.map(h => h.price);
    const histLows   = history.map(h => h.low || h.price);
    const dropAtr = recentDropAtr(history, ind.atr, 5);
    const distFromMean = Math.abs(price - ind.emaSlow) / ind.atr;

    // Pure oversold flag still useful for confidence scoring
    const oversoldNow    = ind.rsi < 30;
    const sharpDrop      = dropAtr > 1.5;
    const belowMean      = price < ind.emaSlow;

    // FIX 1 — RSI turn-up confirmation. rsiMin5 = lowest RSI in last 5 bars
    // (~20h on 4h klines).  Setup: RSI went below 30 sometime in the last 20h
    // AND has now risen at least 3 points off that low AND is back above 30 but
    // not yet past full recovery.  Without this, the strategy buys WHILE still
    // falling — exactly the failure mode of the last 3 losing trades.
    const rsiTurnedUp = ind.rsiMin5 !== null
        && ind.rsiMin5 < 30           // hit oversold within last ~20h
        && ind.rsi >= ind.rsiMin5 + 3 // RSI has climbed ≥3 points off the low
        && ind.rsi >= 32              // confirmed back above oversold zone
        && ind.rsi < 50;              // not already past full recovery

    // FIX 2 — short-term trend filter. 30-bar (5-day at 4h) slope must NOT be
    // strongly negative. MR buying a dip in a real downtrend = catching knives.
    // Original cliffFalling at -15%/10d was way too loose.
    let shortTrendPct = 0;
    if (histPrices.length >= 30) {
        const old30 = histPrices[histPrices.length - 30];
        shortTrendPct = ((histPrices[histPrices.length - 1] - old30) / old30) * 100;
    }
    const aggressiveDowntrend = shortTrendPct < -3.0;  // -3% over 5 days

    // FIX 3 — structural support. We want price near a 7-day low that has been
    // tested multiple times (= an actual support level), not a fresh low (= the
    // floor is still being discovered, more downside likely).
    // 7 days on 4h = 42 bars. Use bar LOWs (not closes) for honest support.
    let nearSupport = false;
    let supportTouches = 0;
    if (histLows.length >= 42) {
        const recent42 = histLows.slice(-42);
        const support = Math.min(...recent42);
        const distFromSupportPct = ((price - support) / support) * 100;
        nearSupport = distFromSupportPct < 2.5;        // price within 2.5% of the 7-day low
        // Count bars (across whole 30-day window) that touched within 1.5% of this support
        supportTouches = histLows.filter(p => p > 0 && p <= support * 1.015).length;
    }
    const supportTested = nearSupport && supportTouches >= 3;

    // Hard filters (any fail = no trade)
    if (aggressiveDowntrend) return null;       // FIX 2
    if (!belowMean) return null;
    if (!rsiTurnedUp) return null;              // FIX 1 — require the turn-up
    if (!sharpDrop) return null;
    if (!supportTested) return null;            // FIX 3 — at tested support

    // --- Confidence components ---
    // Score on the DEEPEST recent oversold (rsiMin5), not current rsi
    // which by definition has already crossed back above 30.
    const oversoldDepth = ind.rsiMin5 !== null ? ind.rsiMin5 : ind.rsi;
    const rsiScore = clamp01((30 - oversoldDepth) / 15); // 0 at RSI=30, 1 at RSI=15
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

    // Win prob: oversold + turn-up + tested support on majors at 4h timeframe.
    // Higher base (0.55) because we now require 3 confirmations vs 1 before;
    // signal quality is materially better even though rate-of-fire is lower.
    let probWin = 0.55;
    if (rsiScore > 0.7) probWin += 0.05;   // RSI was <22 = deep oversold
    if (meanScore > 0.7) probWin += 0.03;
    if (dropScore > 0.6 && dropScore < 1.0) probWin += 0.03;
    if (distFromMean > 4.0) probWin += 0.04;
    if (supportTouches >= 5) probWin += 0.04; // strong support → higher confidence
    probWin = Math.min(0.70, probWin);

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
                rsiPrev: ind.rsiPrev,
                dropAtr,
                distFromMean,
                shortTrendPct,
                supportTouches,
                emaFast: ind.emaFast,
                emaSlow: ind.emaSlow,
                price,
                atr: ind.atr
            }
        },
        reason: `RSI turn-up min5=${ind.rsiMin5?.toFixed(0)}→${ind.rsi.toFixed(0)}; trend ${shortTrendPct.toFixed(1)}% 5d; ${supportTouches}× support tested; ${distFromMean.toFixed(1)}×ATR below mean → EMA_slow ${ind.emaSlow.toFixed(3)}`
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
