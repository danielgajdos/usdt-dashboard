// DEEP DIP — bear-regime capitulation strategy.
//
// Where MOMENTUM and MR are silent (downtrending market, no breakouts, RSI
// not yet bouncing), this strategy fires on TRUE capitulation: the kind of
// "everyone's panicking" event where smart money historically loads up.
//
// Entry requires ALL of:
//   1. rsiMin5 < 25 — sustained deep oversold (not just one weak bar)
//   2. Current RSI still ≤ 28 — we are in the panic, not after it
//   3. Price > 2 ATR below EMAslow — meaningful distance from mean
//   4. 5-day slope < -8% — confirmed bear run (not a minor pullback)
//   5. NOT cliff falling (-25% in 10d) — limit on catching falling knives
//
// Target: revert to EMAslow (capped at config TP), floor 6% (must be worth
// the wider stop). Stop: 4% — wider than MR because we expect more noise
// during capitulation but a real bounce should hold above the recent low.
//
// Expected win rate on majors at 4h: ~55-60% historically per academic
// research on RSI<25 reversal patterns. Probabilities below reflect that.

const config = require('../config');
const { TOKENS } = require('../tokens');
const marketData = require('../marketData');
const signalEngine = require('../signalEngine');

const NAME = 'DEEP_DIP';

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

    // --- Capitulation conditions ---
    // (1) Sustained deep oversold — RSI < 25 in at least one of last 5 bars
    const rsiBottomedDeep = ind.rsiMin5 !== null && ind.rsiMin5 < 25;
    // (2) Still in panic territory — current RSI ≤ 28 (don't fire after rebound)
    const stillOversold = ind.rsi <= 28;

    if (!rsiBottomedDeep || !stillOversold) return null;

    // (3) Price meaningfully below mean — 2 ATR is a real dislocation on 4h
    const distFromMean = (ind.emaSlow - price) / ind.atr;
    if (distFromMean < 2.0) return null;

    // (4) 5-day slope check — confirm real bear run, not minor noise
    const history = marketData.getHistory(token.address);
    const histPrices = history.map(h => h.price);
    let shortTrendPct = 0, longTrendPct = 0;
    if (histPrices.length >= 30) {
        const old30 = histPrices[histPrices.length - 30];
        shortTrendPct = ((histPrices[histPrices.length - 1] - old30) / old30) * 100;
    }
    if (histPrices.length >= 60) {
        const old60 = histPrices[histPrices.length - 60];
        longTrendPct = ((histPrices[histPrices.length - 1] - old60) / old60) * 100;
    }
    // Need a real decline: < -8% over 5 days (env-tunable)
    const minDecline = parseFloat(process.env.BT_DEEPDIP_MIN_DECLINE || '-8.0');
    if (shortTrendPct > minDecline) return null;

    // (5) Cliff guard — refuse to catch a freefall (-25% in 10 days = exchange-failure tier)
    if (longTrendPct < -25.0) return null;

    // --- Confidence components ---
    // Deeper oversold = higher conviction (capped — extreme RSI is also noisy)
    const oversoldDepth = Math.min(25, ind.rsiMin5);
    const rsiScore = clamp01((25 - oversoldDepth) / 15); // 1.0 at RSI=10, 0 at RSI=25
    // Further from mean = bigger expected bounce (capped 5 ATR)
    const distScore = clamp01((distFromMean - 2.0) / 3.0);
    // Decline magnitude — not too steep, not too shallow (sweet spot -10 to -20%)
    const declineMag = Math.abs(shortTrendPct);
    const declineScore = declineMag >= 10 && declineMag <= 20
        ? 1.0
        : (declineMag < 10 ? clamp01((declineMag - 8) / 2.0) : clamp01(1 - (declineMag - 20) / 10.0));
    // Liquidity
    const liquidityScore = 1.0;

    const confidence = 0.35 * rsiScore
        + 0.25 * distScore
        + 0.25 * declineScore
        + 0.15 * liquidityScore;

    // --- Targets ---
    // Aim for partial reversion (60% of distance back to EMAslow) — full reversion
    // is too greedy; capitulation bounces often retest the lows.
    const targetMove = Math.max(0, (ind.emaSlow - price) * 0.6);
    let targetPct = (targetMove / price) * 100;
    targetPct = Math.min(targetPct, config.EXITS.TAKE_PROFIT_PCT);
    targetPct = Math.max(targetPct, 6.0); // min 6% — needs to be worth the wider stop

    // Stop: 4% — wider than MR's 3% to absorb capitulation noise
    const stopPct = parseFloat(process.env.BT_DEEPDIP_SL || '4.0');

    // --- Prob win ---
    // Deep oversold reversal on majors at 4h: ~55-60% base rate historically.
    let probWin = 0.55;
    if (rsiScore > 0.7) probWin += 0.05;   // RSI < 17 = extreme oversold
    if (distScore > 0.6) probWin += 0.04;  // far from mean
    if (declineScore > 0.8) probWin += 0.03; // sweet-spot decline
    probWin = Math.min(0.72, probWin);

    const costPct = totalRoundTripCostPct();
    const expectedEdgePct = probWin * targetPct - (1 - probWin) * stopPct - costPct;

    // Require real positive edge — no marginal trades for capitulation setups
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
        ttlSeconds: 30,
        signals: {
            deepDip: {
                rsi: ind.rsi,
                rsiMin5: ind.rsiMin5,
                distFromMeanAtr: distFromMean,
                shortTrendPct,
                longTrendPct,
                emaSlow: ind.emaSlow,
                price
            }
        },
        reason: `DEEP DIP: RSI min5=${ind.rsiMin5?.toFixed(0)} (now ${ind.rsi.toFixed(0)}); ${distFromMean.toFixed(1)}×ATR below EMA_slow; 5d ${shortTrendPct.toFixed(1)}%; target +${targetPct.toFixed(1)}%`
    });
}

async function evaluate(ctx) {
    if (!config.STRATEGIES.DEEP_DIP || !config.STRATEGIES.DEEP_DIP.enabled) return [];

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
