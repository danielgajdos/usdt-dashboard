// Synthetic-data tests for the Mean Reversion strategy.
// Run: node scripts/testMeanReversion.js

const marketData = require('../marketData');
const meanReversion = require('../strategies/meanReversion');

let failures = 0;
function assert(cond, msg) {
    if (cond) {
        console.log(`  ok   ${msg}`);
    } else {
        console.error(`  FAIL: ${msg}`);
        failures++;
    }
}

// Synthetic token address (just a sentinel — strategy looks it up via getHistory)
const TOKEN = {
    address: '0x1111111111111111111111111111111111111111',
    symbol: 'TEST',
    decimals: 18,
    allowlisted: true,
    minLiquidityUsd: 0
};

// --- Scenario 1: oversold bounce setup ---
// Build a realistic mid-cap price series:
//   - Base period of ~1.5% range (chop typical of a healthy token)
//   - Then 25 bars of -0.4/bar (~-10% total) — Wilder RSI needs many consecutive
//     losses to crater below 28; slope_60 ≈ -10% clears the cliffFalling gate (-15%)
console.log('--- Scenario 1: oversold dip after noisy base (expect ENTER) ---');
{
    marketData.resetAll();
    const prices = [];
    // 75 base samples — sine wave around 100 with ±1.5% range gives ATR ~0.4-0.5
    for (let i = 0; i < 75; i++) {
        prices.push(100 + Math.sin(i / 2) * 1.5);
    }
    // 25-bar sustained drop of 0.4/bar (-10% total from 100.5).
    // Wilder RSI(14) needs many consecutive losses to crater below 28:
    //   RSI ≈ 11 after 25 bars; slope_60 ≈ -10% (well above cliffFalling -15%).
    for (let i = 0; i < 25; i++) {
        prices.push(100.5 - i * 0.4);
    }

    marketData._seedTestHistory(TOKEN.address, prices);
    const ind = marketData.computeIndicators(TOKEN.address);
    console.log(`     RSI=${ind.rsi.toFixed(1)} ATR=${ind.atr.toFixed(3)} EMAfast=${ind.emaFast.toFixed(2)} EMAslow=${ind.emaSlow.toFixed(2)} price=${ind.price.toFixed(2)}`);

    const decision = meanReversion.evaluateToken(TOKEN);
    assert(decision !== null, 'produces an ENTER decision');
    if (decision) {
        assert(decision.action === 'ENTER', 'action is ENTER');
        assert(decision.strategy === 'MEAN_REVERSION', 'strategy is MEAN_REVERSION');
        assert(decision.score > 0, `score > 0 (got ${decision.score})`);
        assert(decision.expectedEdgePct > 0, `expectedEdgePct > 0 (got ${decision.expectedEdgePct.toFixed(2)})`);
        assert(decision.signals.meanReversion.rsi < 28, `rsi triggered oversold (${decision.signals.meanReversion.rsi.toFixed(1)})`);
        assert(decision.signals.meanReversion.dropAtr >= 2.5, `drop in ATR units >= 2.5 (${decision.signals.meanReversion.dropAtr.toFixed(2)})`);
        assert(decision.stopLossPct > 0 && decision.stopLossPct <= 5, `SL within bounds (${decision.stopLossPct})`);
        assert(decision.takeProfitPct >= 3, `TP target sensible (${decision.takeProfitPct.toFixed(2)})`);
    }
}

// --- Scenario 2: steady uptrend, no signal ---
console.log('--- Scenario 2: steady uptrend (expect SKIP / null) ---');
{
    marketData.resetAll();
    const prices = [];
    for (let i = 0; i < 100; i++) {
        prices.push(100 + i * 0.1);
    }
    marketData._seedTestHistory(TOKEN.address, prices);

    const decision = meanReversion.evaluateToken(TOKEN);
    assert(decision === null, 'no decision produced for healthy uptrend');
}

// --- Scenario 3: freefall / aggressive downtrend, must NOT enter ---
// cliffFalling guard fires when 60-bar slope < −15%.
// 50-bar uptrend (100→105) + 50-bar freefall (−0.5/bar, 105→80.5):
//   slope_60 ≈ (80.5 − 104) / 104 ≈ −22.6% → cliffFalling ✓
console.log('--- Scenario 3: aggressive downtrend (expect SKIP / null — don\'t catch falling knives) ---');
{
    marketData.resetAll();
    const prices = [];
    for (let i = 0; i < 50; i++) prices.push(100 + i * 0.1);   // slow rise
    for (let i = 0; i < 50; i++) prices.push(105 - i * 0.5);   // hard freefall −25%
    marketData._seedTestHistory(TOKEN.address, prices);
    const ind = marketData.computeIndicators(TOKEN.address);
    console.log(`     RSI=${ind.rsi.toFixed(1)} EMAfast=${ind.emaFast.toFixed(2)} EMAslow=${ind.emaSlow.toFixed(2)}`);

    const decision = meanReversion.evaluateToken(TOKEN);
    assert(decision === null, 'no decision in freefall (cliffFalling guard)');
}

// --- Scenario 4: not enough history ---
console.log('--- Scenario 4: insufficient history (expect null) ---');
{
    marketData.resetAll();
    const prices = [];
    for (let i = 0; i < 30; i++) prices.push(100 + i * 0.1);
    marketData._seedTestHistory(TOKEN.address, prices);

    const decision = meanReversion.evaluateToken(TOKEN);
    assert(decision === null, 'no decision when history < 70 samples');
}

// --- Scenario 5: depth not OK (thin pool) ---
console.log('--- Scenario 5: depthOk=false (expect null) ---');
{
    marketData.resetAll();
    const prices = [];
    for (let i = 0; i < 75; i++) prices.push(100 + i * 0.05);
    prices.push(102, 101, 99.5, 98, 96.5);
    marketData._seedTestHistory(TOKEN.address, prices, { depthOk: false });

    const decision = meanReversion.evaluateToken(TOKEN);
    assert(decision === null, 'no decision when pool depth check fails');
}

console.log('');
if (failures === 0) {
    console.log('✓ all mean-reversion tests passed');
    process.exit(0);
} else {
    console.error(`✗ ${failures} failure(s)`);
    process.exit(1);
}
