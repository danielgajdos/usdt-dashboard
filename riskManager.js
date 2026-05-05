const config = require('./config');

// State kept in-memory: cooldowns and daily PnL tracking.
const state = {
    cooldowns: new Map(),               // tokenLower -> Date.now() unlock
    dailyStart: { day: null, equity: 0 },
    halted: false,
    haltReason: null,
    haltedUntil: 0
};

function _today() {
    return new Date().toISOString().slice(0, 10);
}

function _cap() {
    return config.RISK.SHADOW_LIVE_CAP_EUR !== null
        ? config.RISK.SHADOW_LIVE_CAP_EUR
        : config.RISK.MAX_POSITION_EUR;
}

// Compute recommended position size for a decision, Kelly-lite.
// cash is current available EUR (portfolio.cashBalance).
function sizePosition(score, cash) {
    const confMult = 0.5 + score / 100; // 0.5 at score=0, 1.5 at score=100
    const base = cash * (config.RISK.BASE_RISK_PCT / 100);
    let size = base * confMult;
    size = Math.min(size, _cap());
    size = Math.max(size, 0);
    return size;
}

// Update daily equity reference at start of each UTC day.
function rollDay(currentEquity) {
    const today = _today();
    if (state.dailyStart.day !== today) {
        state.dailyStart = { day: today, equity: currentEquity };
    }
}

function getDailyDrawdownPct(currentEquity) {
    if (!state.dailyStart.day || state.dailyStart.equity === 0) return 0;
    return ((currentEquity - state.dailyStart.equity) / state.dailyStart.equity) * 100;
}

function halt(reason, durationMs = 24 * 60 * 60 * 1000) {
    state.halted = true;
    state.haltReason = reason;
    state.haltedUntil = Date.now() + durationMs;
}

function resume() {
    state.halted = false;
    state.haltReason = null;
    state.haltedUntil = 0;
}

function isHalted() {
    if (state.halted && Date.now() > state.haltedUntil) {
        resume();
    }
    return state.halted;
}

function recordLoss(tokenAddress) {
    state.cooldowns.set(
        tokenAddress.toLowerCase(),
        Date.now() + config.RISK.COOLDOWN_AFTER_LOSS_SECONDS * 1000
    );
}

function onCooldown(tokenAddress) {
    const until = state.cooldowns.get(tokenAddress.toLowerCase());
    if (!until) return false;
    if (Date.now() > until) {
        state.cooldowns.delete(tokenAddress.toLowerCase());
        return false;
    }
    return true;
}

// Main gate: can we open this position?
// decision: { token, sizeEur, ... }
// portfolio: { cashBalance, investedBalance, positions, totalValue }
// bnbBalance: in BNB units (float)
function canOpen(decision, portfolio, bnbBalance) {
    if (config.STOP_BOT) return { ok: false, reason: 'STOP_BOT flag set' };
    if (isHalted()) return { ok: false, reason: `halted: ${state.haltReason}` };

    // Daily circuit breaker
    rollDay(portfolio.totalValue);
    const ddPct = getDailyDrawdownPct(portfolio.totalValue);
    if (ddPct <= -config.RISK.MAX_DAILY_LOSS_PCT) {
        halt(`daily drawdown ${ddPct.toFixed(2)}% breached`);
        return { ok: false, reason: `daily DD ${ddPct.toFixed(2)}%` };
    }

    // Gas reserve check
    if (bnbBalance !== undefined && bnbBalance < config.RISK.MIN_BNB_GAS_RESERVE) {
        return { ok: false, reason: `BNB gas reserve too low: ${bnbBalance}` };
    }

    // Cash reserve
    const needed = decision.sizeEur + config.COSTS.GAS_PER_TX_USD; // gas ~ USD ~ EUR close enough
    if (portfolio.cashBalance - needed < config.RISK.MIN_CASH_RESERVE_EUR) {
        return { ok: false, reason: 'cash reserve would be breached' };
    }

    // Position size bounds
    if (decision.sizeEur < config.RISK.MIN_POSITION_EUR) {
        return { ok: false, reason: `size €${decision.sizeEur.toFixed(2)} < MIN €${config.RISK.MIN_POSITION_EUR}` };
    }
    if (decision.sizeEur > _cap()) {
        return { ok: false, reason: `size €${decision.sizeEur.toFixed(2)} > cap €${_cap()}` };
    }

    // Concurrent positions cap
    if (portfolio.positions.length >= config.RISK.MAX_CONCURRENT_POSITIONS) {
        return { ok: false, reason: `${portfolio.positions.length} positions >= max ${config.RISK.MAX_CONCURRENT_POSITIONS}` };
    }

    // Total exposure cap
    const exposurePct = ((portfolio.investedBalance + decision.sizeEur) / portfolio.totalValue) * 100;
    if (exposurePct > config.RISK.MAX_EXPOSURE_PCT) {
        return { ok: false, reason: `exposure ${exposurePct.toFixed(1)}% > max ${config.RISK.MAX_EXPOSURE_PCT}%` };
    }

    // Single-token exposure cap (stacking)
    const existingInToken = portfolio.positions
        .filter(p => p.token.toLowerCase() === decision.token.toLowerCase())
        .reduce((s, p) => s + p.initialInvestment, 0);
    const tokenExposurePct = ((existingInToken + decision.sizeEur) / portfolio.totalValue) * 100;
    if (tokenExposurePct > config.RISK.MAX_SINGLE_TOKEN_EXPOSURE_PCT) {
        return { ok: false, reason: `token exposure ${tokenExposurePct.toFixed(1)}% > max ${config.RISK.MAX_SINGLE_TOKEN_EXPOSURE_PCT}%` };
    }

    // Cooldown
    if (onCooldown(decision.token)) {
        return { ok: false, reason: 'token on cooldown after recent loss' };
    }

    return { ok: true };
}

// Check if a position should be exited. Returns {shouldExit, reason} or {shouldExit: false}.
// `indicators` is the full computeIndicators() output (price, emaFast, emaSlow, rsi, atr, ...);
// passing the full object lets us add momentum-death and overheated-RSI exits.
function shouldExit(position, currentPrice, indicators) {
    if (!position || !position.entryPrice) return { shouldExit: false };
    if (!currentPrice || currentPrice <= 0) return { shouldExit: false };

    const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    const ageMin = (Date.now() - new Date(position.timestamp).getTime()) / 60000;
    const currentAtr = indicators ? indicators.atr : null;

    // 1. Stop-loss — hard guard, fires regardless of indicators
    if (pnlPct <= -config.EXITS.STOP_LOSS_PCT) {
        return { shouldExit: true, reason: `SL hit (${pnlPct.toFixed(2)}%)` };
    }

    // 2. Take-profit — full close (no partial; at 4% TP the gross profit barely covers
    // round-trip costs, so leaving 50% on a trailing stop usually loses the win).
    if (pnlPct >= config.EXITS.TAKE_PROFIT_PCT) {
        return { shouldExit: true, reason: `TP hit (${pnlPct.toFixed(2)}%)` };
    }

    // 3. Overheated-RSI exit — if profitable AND RSI tags overbought, take the win
    // before mean reversion eats it.  Specific to MOMENTUM/breakout entries that
    // tend to fade from RSI>75.
    if (indicators && indicators.rsi != null
        && pnlPct > 0.5
        && indicators.rsi >= config.EXITS.OVERHEATED_RSI) {
        return { shouldExit: true, reason: `overheated (RSI ${indicators.rsi.toFixed(0)}, ${pnlPct.toFixed(2)}%)` };
    }

    // 4. Momentum-death exit — only for MOMENTUM entries (mean-reversion trades
    // ENTER with EMAfast < EMAslow by design, so this exit would fire instantly
    // on every MR position).  Strategy-specific gating prevents that.
    if (position.strategy === 'MOMENTUM'
        && indicators && indicators.emaFast != null && indicators.emaSlow != null
        && ageMin >= config.EXITS.MOMENTUM_DEATH_MIN_AGE_MIN
        && indicators.emaFast < indicators.emaSlow) {
        return { shouldExit: true, reason: `momentum dead (EMA cross-down, ${pnlPct.toFixed(2)}%)` };
    }

    // 4b. Mean-reversion-failure exit — for MEAN_REVERSION entries the thesis is
    // "price will bounce back to EMA_slow".  If after the grace period RSI keeps
    // falling AND price keeps moving away from EMA_slow, the bounce isn't coming.
    if (position.strategy === 'MEAN_REVERSION'
        && indicators && indicators.rsi != null && indicators.emaSlow != null
        && ageMin >= config.EXITS.MOMENTUM_DEATH_MIN_AGE_MIN
        && indicators.rsi < 25
        && currentPrice < indicators.emaSlow * 0.99) {
        return { shouldExit: true, reason: `reversion failed (RSI ${indicators.rsi.toFixed(0)}, still below mean, ${pnlPct.toFixed(2)}%)` };
    }

    // 4c. Range-break exit — for RANGE entries the thesis is "price oscillates
    // inside the 15-min band".  If price drops meaningfully below the band low
    // (broke through support), the band is dead — don't wait for the SL hit.
    if (position.strategy === 'RANGE'
        && indicators && indicators.rollingLow15 != null
        && ageMin >= config.EXITS.MOMENTUM_DEATH_MIN_AGE_MIN
        && currentPrice < indicators.rollingLow15 * 0.998) {
        return { shouldExit: true, reason: `range broken (price below 15m low, ${pnlPct.toFixed(2)}%)` };
    }

    // 4d. Range-quick-profit exit — if price reaches the upper half of the
    // 15-min band while we're profitable, take it before the band rolls over.
    if (position.strategy === 'RANGE'
        && indicators && indicators.rollingHigh15 != null && indicators.rollingLow15 != null
        && pnlPct > 1.0) {
        const rangeMid = (indicators.rollingHigh15 + indicators.rollingLow15) / 2;
        if (currentPrice >= rangeMid + 0.4 * (indicators.rollingHigh15 - rangeMid)) {
            return { shouldExit: true, reason: `range hit upper band (${pnlPct.toFixed(2)}%)` };
        }
    }

    // 5. Stuck-loss exit — if a position is older than STUCK_LOSS_AGE_MIN and still
    // negative with no positive momentum, cut it instead of waiting for time stop.
    // Saves ~1-2% on each "drift to nowhere" trade vs the old 240-min timeout.
    if (indicators && indicators.emaFastSlope != null
        && ageMin >= config.EXITS.STUCK_LOSS_AGE_MIN
        && pnlPct < -0.3
        && indicators.emaFastSlope <= 0) {
        return { shouldExit: true, reason: `stuck losing (${pnlPct.toFixed(2)}% @ ${ageMin.toFixed(0)}min, no upside)` };
    }

    // 6. Trailing stop — only kicks in if a previous partial-exit set tookTP1 (legacy)
    if (position.tookTP1 && position.highWaterMark && currentAtr) {
        const trail = position.highWaterMark - config.EXITS.TRAIL_ATR_MULTIPLE * currentAtr;
        if (currentPrice < trail) {
            return { shouldExit: true, reason: `trail stop (${pnlPct.toFixed(2)}%)` };
        }
    }

    // 7. Time stop — final fallback
    if (ageMin >= config.EXITS.MAX_HOLD_MINUTES) {
        return { shouldExit: true, reason: `time stop (${ageMin.toFixed(0)}min, ${pnlPct.toFixed(2)}%)` };
    }

    return { shouldExit: false };
}

function resetState() {
    state.cooldowns.clear();
    state.dailyStart = { day: null, equity: 0 };
    resume();
}

module.exports = {
    sizePosition,
    canOpen,
    shouldExit,
    recordLoss,
    onCooldown,
    halt,
    resume,
    isHalted,
    rollDay,
    getDailyDrawdownPct,
    resetState,
    _internalState: state
};
