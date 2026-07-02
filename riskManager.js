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

// Compute recommended position size for a decision, Kelly-lite, then taper for
// pool depth.  `depthDeviation` is the measured price-impact (fraction) of a
// probe buy at MAX_POSITION_EUR notional (from marketData.getDepthDeviation).
// Backtest proved edge dies above ~0.6% slippage, so we shrink size on thin
// pools to keep projected impact ≤ TARGET_ENTRY_SLIPPAGE_PCT.
//
//   impact scales ~linearly with size for an AMM: impact(S) ≈ deviation × S/probe.
//   To hold impact ≤ target:  S ≤ probe × target / deviation.
function sizePosition(score, cash, depthDeviation = null) {
    const confMult = 0.5 + score / 100; // 0.5 at score=0, 1.5 at score=100
    const base = cash * (config.RISK.BASE_RISK_PCT / 100);
    let size = base * confMult;
    size = Math.min(size, _cap());

    // Depth-scaled taper: deviation was measured at the MAX_POSITION_EUR probe.
    if (depthDeviation != null && depthDeviation > 0) {
        const probe = config.RISK.MAX_POSITION_EUR;
        const targetFrac = config.COSTS.TARGET_ENTRY_SLIPPAGE_PCT / 100;
        if (depthDeviation > targetFrac) {
            const slippageCappedSize = probe * (targetFrac / depthDeviation);
            size = Math.min(size, slippageCappedSize);
        }
    }

    size = Math.max(size, 0);
    return size;
}

// Would a position of `sizeEur` exceed the hard slippage ceiling, given the
// pool's measured depth deviation (at MAX_POSITION_EUR probe)?  Linear scaling.
// Returns { ok, projectedPct } — projectedPct is the estimated impact at this size.
function passesSlippageGate(sizeEur, depthDeviation) {
    if (depthDeviation == null) return { ok: true, projectedPct: null }; // unmeasured → don't block
    const probe = config.RISK.MAX_POSITION_EUR;
    const projected = depthDeviation * (sizeEur / probe);      // fraction
    const projectedPct = projected * 100;
    return { ok: projectedPct <= config.COSTS.MAX_ENTRY_SLIPPAGE_PCT, projectedPct };
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

    // Track the high-water mark (self-contained so BOTH the DEX bot and the
    // futures shadow venue get trailing without extra wiring).
    if (currentPrice > (position.highWaterMark || 0)) position.highWaterMark = currentPrice;
    // Low-water mark (MAE tracking). Forensics 2026-07: 42% of entries went
    // straight to SL — MFE/MAE per trade tells us whether losers ever went
    // positive first (entry-timing problem) or never did (signal problem).
    if (!position.lowWaterMark || currentPrice < position.lowWaterMark) position.lowWaterMark = currentPrice;

    // 2. Profit exit — strategy-aware.
    if (position.strategy === 'MOMENTUM') {
        // ATR-trailing: let the rare big winners run (they pay for the losers).
        // Safety cap banks a runaway; otherwise trail K×ATR below the HWM once
        // we're past the activation threshold. Below activation: no cap, let it go.
        if (pnlPct >= config.EXITS.TRAIL_SAFETY_TP_PCT) {
            return { shouldExit: true, reason: `TP cap (${pnlPct.toFixed(2)}%)` };
        }
        if (currentAtr && position.highWaterMark) {
            const hwmProfitPct = ((position.highWaterMark - position.entryPrice) / position.entryPrice) * 100;
            if (hwmProfitPct >= config.EXITS.TRAIL_ACTIVATE_PCT) {
                const trailLevel = position.highWaterMark - config.EXITS.TRAIL_ATR_MULT * currentAtr;
                if (currentPrice < trailLevel) {
                    return { shouldExit: true, reason: `trail stop (peak +${hwmProfitPct.toFixed(1)}%, now ${pnlPct.toFixed(2)}%)` };
                }
            }
        }
    } else {
        // Non-momentum (MEAN_REVERSION etc.) — fixed TP; reversion has a defined
        // target and no fat tail to chase.
        if (pnlPct >= config.EXITS.TAKE_PROFIT_PCT) {
            return { shouldExit: true, reason: `TP hit (${pnlPct.toFixed(2)}%)` };
        }
        // Overheated-RSI exit — take the win before mean reversion eats it.
        // (Removed for MOMENTUM: trailing supersedes it and it was cutting runners early.)
        if (indicators && indicators.rsi != null
            && pnlPct > 0.5
            && indicators.rsi >= config.EXITS.OVERHEATED_RSI) {
            return { shouldExit: true, reason: `overheated (RSI ${indicators.rsi.toFixed(0)}, ${pnlPct.toFixed(2)}%)` };
        }
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
    passesSlippageGate,
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
