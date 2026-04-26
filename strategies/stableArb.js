// Stablecoin depeg arbitrage — STUB. Will quote USDT/USDC/BUSD/FDUSD/DAI
// across PCS V2, PCS V3, and Biswap and execute atomic two-leg swaps when
// the spread exceeds round-trip costs. Until the V3 quoter + atomic
// executor are wired, this returns no decisions.

const NAME = 'STABLE_ARB';

async function evaluate(/* ctx */) {
    return [];
}

module.exports = { name: NAME, evaluate };
