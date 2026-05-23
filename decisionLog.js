// Decision log + adaptive strategy weighting.
//
// Every entry decision the bot makes (passed OR rejected at the gate) is
// appended to /app/data/decisionLog.jsonl as a one-line JSON record.
// On bot startup we replay the last N entries to compute per-strategy
// win-rate over the recent window and adjust STRATEGIES[X].weight in-memory
// accordingly.  Weights are clamped to [0.5, 1.5] so a bad week can't
// disable a strategy entirely, but it can be down-weighted.
//
// This is the "learning" layer — strategies that recently performed badly
// get their score multiplied down (less likely to pass MIN_SCORE), strategies
// that won recently get scored up.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const LOG_PATH = process.env.DECISION_LOG_PATH || '/app/data/decisionLog.jsonl';
const MAX_LOG_LINES = 5000; // truncate from front when exceeded
const ANALYSIS_WINDOW = 50;  // last 50 trades per strategy for weight calc

// Append a single decision entry.
// Shape: { ts, kind: 'pass'|'gate'|'risk'|'exit', strategy, symbol, score, edge,
//          confidence, sizeEur?, entryPrice?, exitPrice?, pnl?, pnlPct?, reason?, ... }
function append(entry) {
    try {
        const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
        fs.appendFileSync(LOG_PATH, line);
    } catch (e) {
        // Don't crash the bot on log failure
        console.error('decisionLog append failed:', e.message);
    }
}

// Read the last N lines of the log (in-memory friendly via tail-style read).
function readLines(maxLines = 1000) {
    try {
        if (!fs.existsSync(LOG_PATH)) return [];
        const data = fs.readFileSync(LOG_PATH, 'utf8');
        const lines = data.trim().split('\n').filter(Boolean);
        const slice = lines.slice(-maxLines);
        return slice.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
        return [];
    }
}

// Truncate from the front if the file is too large.
function truncate() {
    try {
        if (!fs.existsSync(LOG_PATH)) return;
        const data = fs.readFileSync(LOG_PATH, 'utf8');
        const lines = data.trim().split('\n').filter(Boolean);
        if (lines.length > MAX_LOG_LINES) {
            const keep = lines.slice(-MAX_LOG_LINES);
            fs.writeFileSync(LOG_PATH, keep.join('\n') + '\n');
        }
    } catch {}
}

// Build per-strategy performance stats from the last ANALYSIS_WINDOW exits.
// Only EXIT records have realized PnL; we use those.
function computeStrategyStats(windowLines = 2000) {
    const lines = readLines(windowLines);
    const exits = lines.filter(l => l.kind === 'exit' && typeof l.pnl === 'number' && l.strategy);
    const byStrat = {};
    for (const e of exits) {
        if (!byStrat[e.strategy]) byStrat[e.strategy] = { trades: [], wins: 0, losses: 0, totalPnl: 0 };
        const s = byStrat[e.strategy];
        s.trades.push(e);
        if (e.pnl > 0) s.wins++; else s.losses++;
        s.totalPnl += e.pnl;
    }
    // Only keep last ANALYSIS_WINDOW per strategy
    for (const k of Object.keys(byStrat)) {
        const s = byStrat[k];
        const tail = s.trades.slice(-ANALYSIS_WINDOW);
        s.trades = tail;
        s.wins = tail.filter(t => t.pnl > 0).length;
        s.losses = tail.length - s.wins;
        s.totalPnl = tail.reduce((a, t) => a + t.pnl, 0);
        s.winRate = tail.length > 0 ? s.wins / tail.length : 0;
        const grossWin = tail.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
        const grossLoss = -tail.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
        s.profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
        s.sampleSize = tail.length;
    }
    return byStrat;
}

// Compute adjusted strategy weights based on recent performance.
// Logic:
//   - Need at least 5 trades to make any adjustment
//   - Profit factor > 1.5 → bump weight ×1.2 (max 1.5)
//   - Profit factor 1.0-1.5 → keep weight
//   - Profit factor 0.5-1.0 → cut weight ×0.8
//   - Profit factor < 0.5 → cut weight ×0.6 (min 0.5)
// Returns map of { strategyName: { oldWeight, newWeight, reason } }.
function computeAdaptiveWeights() {
    const stats = computeStrategyStats();
    const out = {};
    for (const [name, s] of Object.entries(stats)) {
        const cfg = config.STRATEGIES[name];
        if (!cfg) continue;
        const oldWeight = cfg.weight;
        let newWeight = oldWeight;
        let reason = `${s.sampleSize} trades, PF ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}`;

        if (s.sampleSize < 5) {
            reason += ' — too few samples, no change';
        } else if (s.profitFactor > 1.5) {
            newWeight = Math.min(1.5, oldWeight * 1.2);
            reason += ' — boosted';
        } else if (s.profitFactor >= 1.0) {
            reason += ' — held';
        } else if (s.profitFactor >= 0.5) {
            newWeight = Math.max(0.5, oldWeight * 0.8);
            reason += ' — cut';
        } else {
            newWeight = Math.max(0.5, oldWeight * 0.6);
            reason += ' — heavy cut';
        }

        out[name] = { oldWeight, newWeight, reason };
    }
    return out;
}

// Apply the computed adaptive weights to live config (in-memory).
// Called at startup and (optionally) periodically.
function applyAdaptiveWeights(log = console.log) {
    truncate();
    const adjustments = computeAdaptiveWeights();
    for (const [name, a] of Object.entries(adjustments)) {
        if (a.newWeight !== a.oldWeight) {
            config.STRATEGIES[name].weight = a.newWeight;
            log(`[adaptive] ${name}: weight ${a.oldWeight.toFixed(2)} → ${a.newWeight.toFixed(2)} (${a.reason})`);
        } else {
            log(`[adaptive] ${name}: weight ${a.oldWeight.toFixed(2)} unchanged (${a.reason})`);
        }
    }
    return adjustments;
}

// --- Convenience loggers used at decision-flow points ---
function logEntry(decision) {
    append({
        kind: 'pass',
        strategy: decision.strategy,
        symbol: decision.symbol,
        token: decision.token,
        score: decision.score,
        edge: decision.expectedEdgePct,
        confidence: decision.confidence,
        sizeEur: decision.sizeEur,
        reason: decision.reason
    });
}
function logGateBlock(decision, reason) {
    // Only log gate blocks for high-scoring decisions (avoid log spam)
    if (decision.score < config.SIGNAL.MIN_SCORE - 15) return;
    append({
        kind: 'gate',
        strategy: decision.strategy,
        symbol: decision.symbol,
        score: decision.score,
        edge: decision.expectedEdgePct,
        confidence: decision.confidence,
        reason
    });
}
function logExit(position, exitValueEur, pnlEur, pnlPct, reason) {
    append({
        kind: 'exit',
        strategy: position.strategy,
        symbol: position.symbol,
        token: position.token,
        entryPrice: position.entryPrice,
        investedEur: position.amountEur || position.initialInvestment,
        exitValueEur,
        pnl: pnlEur,
        pnlPct,
        heldMin: Math.round((Date.now() - new Date(position.timestamp).getTime()) / 60000),
        reason
    });
}

module.exports = {
    append,
    readLines,
    truncate,
    computeStrategyStats,
    computeAdaptiveWeights,
    applyAdaptiveWeights,
    logEntry,
    logGateBlock,
    logExit
};
