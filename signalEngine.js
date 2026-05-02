const config = require('./config');
const timeRegime = require('./signals/timeRegime');

// The Decision shape — every strategy returns this.
function emptyDecision(overrides = {}) {
    return {
        action: 'SKIP',
        strategy: 'unknown',
        token: null,
        symbol: null,
        sizeEur: 0,
        score: 0,
        confidence: 0,
        expectedEdgePct: 0,
        stopLossPct: config.EXITS.STOP_LOSS_PCT,
        takeProfitPct: config.EXITS.TAKE_PROFIT_PCT,
        ttlSeconds: config.SIGNAL.DECISION_TTL_SECONDS,
        timestamp: Date.now(),
        signals: {},
        reason: '',
        ...overrides
    };
}

function scoreDecision(edgePct, confidence) {
    // Confidence-weighted: with tighter targets (TP=4%, SL=2.5%), expected
    // edges are smaller in absolute terms — confidence (signal quality) is
    // a better discriminator than raw edge magnitude.  Old 60/40 split made
    // every signal collapse to score < 50.
    const edgeScore = Math.max(0, Math.min(1, edgePct / config.SIGNAL.TARGET_EDGE_PCT));
    const confScore = Math.max(0, Math.min(1, confidence));
    return Math.round(100 * (0.4 * edgeScore + 0.6 * confScore));
}

// Registered strategies. Each must export: name, evaluate(ctx) → Decision[]
const strategies = [];

function register(strategy) {
    if (!strategy.name || typeof strategy.evaluate !== 'function') {
        throw new Error('Invalid strategy registration');
    }
    strategies.push(strategy);
}

// Run all enabled strategies in parallel, return sorted viable decisions.
// ctx = { provider, signer, portfolio, log }
async function scan(ctx) {
    const cfg = config.STRATEGIES;
    const enabled = strategies.filter(s => cfg[s.name] && cfg[s.name].enabled);

    const results = await Promise.all(
        enabled.map(async s => {
            try {
                const decisions = await s.evaluate(ctx);
                // Apply strategy weight to score
                const weight = cfg[s.name].weight || 1.0;
                return (decisions || []).map(d => ({
                    ...d,
                    score: Math.round(d.score * weight)
                }));
            } catch (err) {
                if (ctx.log) ctx.log(`[SignalEngine] Strategy ${s.name} failed: ${err.message}`, 'error');
                return [];
            }
        })
    );

    // Apply time-of-day regime: scale scores by liquidity multiplier.
    // Dead zones (04-07 UTC) suppress scores — strategies still evaluate but
    // need a stronger signal to clear the gate.
    const regime = timeRegime.getRegime();
    const all = results.flat().map(d => ({
        ...d,
        score: Math.round(d.score * regime.multiplier),
        signals: { ...d.signals, regime: { name: regime.name, multiplier: regime.multiplier } }
    }));

    return all.sort((a, b) => b.score - a.score);
}

// The single unified gate — the only threshold check in the entire codebase.
function passesGate(decision, ctx) {
    if (!decision || decision.action === 'SKIP') return { ok: false, reason: 'skip' };
    if (decision.score < config.SIGNAL.MIN_SCORE) {
        return { ok: false, reason: `score ${decision.score} < MIN_SCORE ${config.SIGNAL.MIN_SCORE}` };
    }
    if (decision.expectedEdgePct < config.SIGNAL.MIN_EDGE_PCT_AFTER_COSTS) {
        return { ok: false, reason: `edge ${decision.expectedEdgePct.toFixed(2)}% < ${config.SIGNAL.MIN_EDGE_PCT_AFTER_COSTS}%` };
    }
    const age = (Date.now() - decision.timestamp) / 1000;
    if (age > decision.ttlSeconds) {
        return { ok: false, reason: `stale (${age.toFixed(0)}s > ttl ${decision.ttlSeconds}s)` };
    }
    if (ctx && ctx.riskManager) {
        const r = ctx.riskManager.canOpen(decision);
        if (!r.ok) return { ok: false, reason: `risk: ${r.reason}` };
    }
    return { ok: true };
}

function listStrategies() {
    return strategies.map(s => s.name);
}

function reset() {
    strategies.length = 0;
}

module.exports = {
    emptyDecision,
    scoreDecision,
    register,
    scan,
    passesGate,
    listStrategies,
    reset
};
