// News-driven LLM strategy.
//
// Consumes signals from signals/newsLLM.js.  Each valid signal becomes an ENTER
// decision if the momentum indicator confirms the LLM direction (co-signal gate)
// and the position is not already open.
//
// Typical signal flow:
//   CryptoCompare headline → Claude Haiku → { UP, conf=78, mag=5% }
//   → momentum confirms UP → Decision { score ~65, edge ~1.8% }

'use strict';

const config = require('../config');
const { TOKENS } = require('../tokens');
const marketData = require('../marketData');
const signalEngine = require('../signalEngine');
const newsLLM = require('../signals/newsLLM');

const NAME = 'NEWS_DRIVEN';
const clamp01 = v => Math.max(0, Math.min(1, v));

// Co-signal check: does market data agree with the LLM direction?
// Returns a momentum alignment score in [0, 1]. 0 = disagreement, 1 = strong agreement.
function momentumAlignment(tokenAddress, direction) {
    const ind = marketData.computeIndicators(tokenAddress);
    if (!ind || ind.samples < 70) return 0.5; // neutral — not enough history yet

    let score = 0.5;
    if (direction === 'UP') {
        if (ind.emaFast > ind.emaSlow) score += 0.2;     // trend aligns
        if (ind.emaFastSlope > 0) score += 0.1;          // accelerating up
        if (ind.rsi > 40 && ind.rsi < 70) score += 0.2;  // healthy, not overbought
    } else { // DOWN
        if (ind.emaFast < ind.emaSlow) score += 0.2;
        if (ind.emaFastSlope < 0) score += 0.1;
        if (ind.rsi < 60 && ind.rsi > 30) score += 0.2;
    }
    return clamp01(score);
}

// Round-trip cost — same realistic model as meanReversion
function totalCostPct() {
    return 2 * config.COSTS.SWAP_FEE_PCT
        + 2 * (config.COSTS.EXPECTED_SLIPPAGE_PCT || 0.10)
        + (2 * config.COSTS.GAS_PER_TX_USD / config.RISK.MAX_POSITION_EUR) * 100;
}

function evaluateToken(token, signal, openTokens) {
    if (openTokens.has(token.address.toLowerCase())) return null;

    // LLM gate
    if (signal.confidence < config.NEWS.MIN_LLM_CONFIDENCE) return null;
    if (signal.magnitudePct < config.NEWS.MIN_LLM_MAGNITUDE_PCT) return null;
    if (signal.direction !== 'UP') return null; // long-only for phase 1

    // Depth / liquidity gate
    const ind = marketData.computeIndicators(token.address);
    if (ind && !ind.depthOk) return null;

    // Co-signal gate — LLM must agree with at least neutral momentum
    const alignment = momentumAlignment(token.address, signal.direction);
    if (alignment < 0.5) return null; // momentum actively disagrees

    // --- Confidence = blend of LLM conviction and momentum alignment ---
    const llmScore = clamp01(signal.confidence / 100);
    const confidence = 0.50 * llmScore + 0.50 * alignment;

    // Target = LLM-predicted magnitude, stop very tight (news events resolve fast)
    const targetPct = Math.min(signal.magnitudePct, config.EXITS.TAKE_PROFIT_PCT);
    const stopPct = Math.min(2.5, config.EXITS.STOP_LOSS_PCT * 0.5);

    // News signals historically ~52-57% hit rate — event-driven but noisy
    let probWin = 0.52;
    if (signal.confidence >= 80) probWin += 0.05;
    if (alignment >= 0.7) probWin += 0.03;
    probWin = Math.min(0.62, probWin);

    const expectedEdgePct = probWin * targetPct - (1 - probWin) * stopPct - totalCostPct();
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
        ttlSeconds: 8, // news windows close fast
        signals: {
            news: {
                direction: signal.direction,
                confidence: signal.confidence,
                magnitudePct: signal.magnitudePct,
                reason: signal.reason,
                alignment
            }
        },
        reason: `LLM news: ${signal.direction} conf=${signal.confidence} mag=${signal.magnitudePct}% align=${alignment.toFixed(2)} — ${signal.reason}`
    });
}

async function evaluate(ctx) {
    if (!process.env.ANTHROPIC_API_KEY) return [];
    if (!config.STRATEGIES.NEWS_DRIVEN?.enabled) return [];

    const { portfolio } = ctx;
    const openTokens = new Set(
        (portfolio.getOpenPositions() || []).map(p => p.token.toLowerCase())
    );

    const decisions = [];
    for (const token of TOKENS) {
        const signal = newsLLM.getSignal(token.symbol);
        if (!signal) continue;
        const d = evaluateToken(token, signal, openTokens);
        if (d) decisions.push(d);
    }
    return decisions;
}

module.exports = { name: NAME, evaluate, evaluateToken };
