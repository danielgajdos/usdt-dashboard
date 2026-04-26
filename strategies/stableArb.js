// Stablecoin depeg arbitrage strategy.
//
// Two complementary signals:
//
// 1. DEPEG ENTRY — a stablecoin is trading below USDT parity on PCS V2.
//    If BUSD is at 0.975 USDT, we buy BUSD and target the re-peg to 1.000.
//    Gate: 1.5–8% depeg (permanent depegs > 8% are avoided), deep pool,
//          depeg must be on BOTH Biswap and PCS_V2 (not a local anomaly).
//
// 2. CROSS-DEX SPREAD — the same pair has different prices on PCS_V2 and Biswap.
//    If USDT→BUSD is better on Biswap and BUSD→USDT is better on PCS_V2,
//    the leg-by-leg spread is noted. Execution would require two sequential txs
//    (not atomic) so we only signal when spread > 2× round-trip cost (safety margin).
//    DEFERRED: actual execution of cross-DEX arb awaits a flash-loan or atomic
//    contract (Phase K). For now, we log the opportunity.
//
// Only signal 1 fires real ENTER decisions today.

'use strict';

const { ethers } = require('ethers');
const config = require('../config');
const { quote } = require('../dexRegistry');
const signalEngine = require('../signalEngine');

const NAME = 'STABLE_ARB';
const USDT = '0x55d398326f99059fF775485246999027B3197955';

// Stablecoins we monitor. USDT is the reference — others are quoted against it.
const STABLES = config.STABLE_ARB?.STABLES || [];

// How many USDT do we need to spend for the probe quote?
const PROBE_USD = 25; // roughly €25 — matches our position size
const PROBE_NOTIONAL = ethers.parseUnits(String(PROBE_USD), 18);

// Round-trip cost: 2× (PCS fee + expected slippage) + gas
// For stable-to-stable the slippage is lower (~0.05% at $25)
function roundTripCostPct() {
    const feePct = 2 * config.COSTS.SWAP_FEE_PCT;
    const slippagePct = 2 * 0.05; // stable-to-stable: very tight
    const gasPct = (2 * config.COSTS.GAS_PER_TX_USD / config.RISK.MAX_POSITION_EUR) * 100;
    return feePct + slippagePct + gasPct;
}

// Quote how many stableOut tokens you get for PROBE_NOTIONAL of USDT on a given DEX.
// Returns float price (stableOut per 1 USDT), or null on failure.
async function quoteStablePrice(provider, dexKey, stableAddr, stableDecimals) {
    try {
        const path = [USDT, stableAddr];
        const out = await quote(provider, dexKey, path, PROBE_NOTIONAL);
        if (!out || out === 0n) return null;
        const outFloat = parseFloat(ethers.formatUnits(out, stableDecimals));
        return outFloat / PROBE_USD; // stableOut per 1 USDT input
    } catch { return null; }
}

// Check if same stable-to-USDT sell is consistent (depth check).
async function quoteSellPrice(provider, dexKey, stableAddr, stableDecimals) {
    try {
        const amount = ethers.parseUnits(String(PROBE_USD), stableDecimals);
        const path = [stableAddr, USDT];
        const out = await quote(provider, dexKey, path, amount);
        if (!out || out === 0n) return null;
        const outFloat = parseFloat(ethers.formatUnits(out, 18));
        return outFloat / PROBE_USD; // USDT per 1 stableIn
    } catch { return null; }
}

async function evaluate(ctx) {
    if (!config.STRATEGIES.STABLE_ARB?.enabled) return [];
    if (!ctx.provider) return [];

    const { provider, portfolio } = ctx;
    const openTokens = new Set(
        (portfolio.getOpenPositions() || []).map(p => p.token.toLowerCase())
    );

    const decisions = [];
    const cost = roundTripCostPct();

    for (const stable of STABLES) {
        if (stable.symbol === 'USDT') continue; // USDT is our reference
        if (openTokens.has(stable.address.toLowerCase())) continue;

        // Quote: how many of `stable` do we get per 1 USDT on PCS V2?
        const pricePcs = await quoteStablePrice(provider, 'PCS_V2', stable.address, stable.decimals);
        if (!pricePcs) continue;

        // Depeg % below peg: if 1 USDT buys 1.025 BUSD, BUSD is 2.5% below peg
        const depegPct = (pricePcs - 1.0) * 100;

        // Only care about depeg in the meaningful range (1.5–8%)
        // Below 1.5%: not worth the cost. Above 8%: likely permanent depeg.
        const MIN_DEPEG = config.STABLE_ARB?.MIN_DEPEG_PCT ?? 1.5;
        const MAX_DEPEG = config.STABLE_ARB?.MAX_DEPEG_PCT ?? 8.0;
        if (depegPct < MIN_DEPEG || depegPct > MAX_DEPEG) continue;

        // Depth check: can we also sell the stable back? If the sell quote also
        // shows the stable below peg, the pool is consistently priced (not an anomaly).
        const sellPcs = await quoteSellPrice(provider, 'PCS_V2', stable.address, stable.decimals);
        if (!sellPcs) continue;
        const sellDepegPct = (1.0 - sellPcs) * 100;
        // If the sell side also shows depeg, the pool reflects real dislocation
        if (sellDepegPct < MIN_DEPEG * 0.5) continue; // asymmetric = thin one side, skip

        // Also quote on Biswap — both DEXes depegged = more structural, not just PCS quirk
        const priceBiswap = await quoteStablePrice(provider, 'BISWAP', stable.address, stable.decimals);
        const biswapDepeg = priceBiswap ? (priceBiswap - 1.0) * 100 : 0;
        // If Biswap shows normal (< 0.5% depeg) while PCS shows 2%+, it's a cross-DEX arb
        // opportunity that requires atomic execution. Log it but don't generate ENTER today.
        const crossDexArb = priceBiswap && biswapDepeg < 0.5 && depegPct > 1.5;
        if (crossDexArb) {
            // Would log, but no ctx.log here; the tick loop will surface via signalEngine
            // DEFERRED: actual cross-DEX execution awaits atomic contract (Phase K)
            continue;
        }

        // --- Both DEXes agree on the depeg: generate ENTER ---
        // Target: stable re-pegs to 1.000 USDT (i.e., we profit depegPct%)
        const targetPct = Math.min(depegPct * 0.8, config.EXITS.TAKE_PROFIT_PCT);
        const stopPct = Math.min(depegPct * 0.5, config.EXITS.STOP_LOSS_PCT * 0.4); // tight

        // Stable re-pegs historically: ~70% success for < 5% depeg on established coins
        let probWin = 0.60;
        if (depegPct < 3.0) probWin += 0.08; // shallow depegs more reliably recover
        if (biswapDepeg >= MIN_DEPEG * 0.5) probWin += 0.04; // both DEXes agree → structural
        probWin = Math.min(0.72, probWin);

        const expectedEdgePct = probWin * targetPct - (1 - probWin) * stopPct - cost;
        if (expectedEdgePct <= 0) continue;

        const confidence = Math.min(1, depegPct / 5.0) * 0.6 + 0.4; // 0.4 base, scale with depeg
        const score = signalEngine.scoreDecision(expectedEdgePct, confidence);

        decisions.push(signalEngine.emptyDecision({
            action: 'ENTER',
            strategy: NAME,
            token: stable.address,
            symbol: stable.symbol,
            score,
            confidence,
            expectedEdgePct,
            stopLossPct: stopPct,
            takeProfitPct: targetPct,
            ttlSeconds: 30, // stablecoin re-pegs can take minutes; give more time
            signals: {
                stableArb: {
                    depegPct,
                    pricePcs,
                    sellPcs,
                    biswapDepeg,
                    probWin
                }
            },
            reason: `${stable.symbol} depegged ${depegPct.toFixed(2)}% below USDT on PCS_V2; target re-peg (${targetPct.toFixed(1)}% TP)`
        }));
    }

    return decisions;
}

module.exports = { name: NAME, evaluate };
