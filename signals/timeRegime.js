// Time-of-day regime filter.
//
// BSC/crypto hourly liquidity pattern (UTC):
//   00-01  Asia pre-open      moderate  0.85
//   01-04  Asia session       active    1.00
//   04-07  Asia/EU gap        dead      0.60  ← worst false-breakout window
//   07-09  EU open            hot       1.10
//   09-13  EU mid-session     good      0.95
//   13-15  US open            hottest   1.15  ← best for momentum/breakout
//   15-20  US session         good      1.00
//   20-22  US late            moderate  0.90
//   22-24  US close/Asia pre  moderate  0.85
//
// The multiplier is applied to:
//   - probWin adjustments (multiplies the bonus added above base)
//   - effective MIN_SCORE threshold (inverse — dead zone raises the bar)
//
// This is a pure statistical filter, no I/O needed.

'use strict';

// Hour → regime multiplier lookup (UTC hours 0-23).
// 2026-05-07: softened the dead-zone (was 0.60-0.70) — early-exit logic now
// catches false breakouts in 5-15min, so the heavy multiplier penalty was
// killing too many otherwise-tradeable signals during the Asia/EU gap.
const HOUR_MULTIPLIER = [
//  0     1     2     3     4     5     6     7     8     9    10    11
    0.90, 1.00, 1.00, 1.00, 0.85, 0.80, 0.85, 1.10, 1.10, 0.95, 0.95, 0.95,
//  12    13    14    15    16    17    18    19    20    21    22    23
    0.95, 1.15, 1.15, 1.00, 1.00, 1.00, 1.00, 1.00, 0.95, 0.90, 0.90, 0.90
];

const REGIME_NAMES = [
//  0            1            2            3            4            5
    'Asia-pre',  'Asia',      'Asia',      'Asia',      'Gap',       'Gap-dead',
//  6            7            8            9            10           11
    'Gap',       'EU-open',   'EU-open',   'EU-mid',    'EU-mid',    'EU-mid',
//  12           13           14           15           16           17
    'EU-mid',    'US-open',   'US-open',   'US-sess',   'US-sess',   'US-sess',
//  18           19           20           21           22           23
    'US-sess',   'US-sess',   'US-late',   'US-late',   'Asia-pre',  'Asia-pre'
];

/**
 * Returns the regime for the current UTC time.
 * {
 *   multiplier: number,  // 0.60 – 1.15
 *   name: string,        // e.g. 'US-open'
 *   hourUtc: number,     // 0-23
 *   isDeadZone: boolean  // multiplier < 0.75
 * }
 */
function getRegime(nowMs = Date.now()) {
    const hourUtc = new Date(nowMs).getUTCHours();
    const multiplier = HOUR_MULTIPLIER[hourUtc];
    return {
        multiplier,
        name: REGIME_NAMES[hourUtc],
        hourUtc,
        isDeadZone: multiplier < 0.75
    };
}

/**
 * Apply regime to a candidate decision object.
 * Modifies probWin bonus by multiplier and raises the effective score bar
 * in dead zones.  Returns { allow, regime, adjustedScore }.
 *
 * @param {number} rawScore  - signalEngine score (0-100)
 * @param {number} probWinBonus - the bonus above base probWin (not base itself)
 * @returns {{ allow: boolean, regime: object, probWinBonus: number }}
 */
function applyRegime(rawScore, probWinBonus = 0) {
    const regime = getRegime();

    // Dead zone: require a higher score bar (effectively raise MIN_SCORE by 10pt)
    if (regime.isDeadZone) {
        const effectiveMinScore = (require('../config').SIGNAL?.MIN_SCORE || 70) + 10;
        if (rawScore < effectiveMinScore) {
            return { allow: false, regime, probWinBonus };
        }
    }

    // Scale the bonus contribution by the regime multiplier
    const adjustedBonus = probWinBonus * regime.multiplier;
    return { allow: true, regime, probWinBonus: adjustedBonus };
}

/**
 * Quick check: should we even bother running strategies right now?
 * In a dead zone we still run but require stronger signals.
 */
function shouldThrottle() {
    return getRegime().isDeadZone;
}

module.exports = { getRegime, applyRegime, shouldThrottle, HOUR_MULTIPLIER };
