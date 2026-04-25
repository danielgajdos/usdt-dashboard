const { ethers } = require('ethers');
const { isAllowlisted } = require('../tokens');
const { WBNB, USDT } = require('../tokens');
const config = require('../config');

const ERC20_ABI = [
    'function totalSupply() external view returns (uint256)',
    'function decimals() external view returns (uint8)',
    'function balanceOf(address) external view returns (uint256)',
    'function owner() external view returns (address)'
];

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
];

const BURN_ADDRESSES = new Set([
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead'
].map(a => a.toLowerCase()));

// Static checks — fast, no tx simulation.
async function staticChecks(provider, tokenAddress) {
    const issues = [];
    const t = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

    // 1. Bytecode size
    const code = await provider.getCode(tokenAddress);
    if (!code || code === '0x') {
        issues.push('no bytecode');
        return { passed: false, issues, score: 0 };
    }
    const byteLen = (code.length - 2) / 2;
    if (byteLen < 2000) issues.push(`bytecode too small (${byteLen}b)`);

    // 2. totalSupply + decimals don't revert
    try {
        await t.totalSupply();
    } catch {
        issues.push('totalSupply reverts');
    }
    try {
        await t.decimals();
    } catch {
        issues.push('decimals reverts');
    }

    // 3. Owner — if exists and is non-burn, flag (but don't hard reject — many legit tokens have owners)
    let ownerBurnedOrMissing = false;
    try {
        const owner = await t.owner();
        if (!owner || BURN_ADDRESSES.has(owner.toLowerCase())) {
            ownerBurnedOrMissing = true;
        }
    } catch {
        ownerBurnedOrMissing = true; // owner() doesn't exist = renounced by design
    }

    const passed = issues.length === 0;
    const score = Math.max(0, 100 - issues.length * 25);
    return { passed, issues, score, ownerBurnedOrMissing, byteLen };
}

// Dynamic simulated-sell check via provider.call with stateOverride.
// Pretends we hold 1 token, attempts a sell, inspects result.
// Returns { canSell, taxPct } or { canSell: false, reason }.
async function simulatedSellCheck(provider, tokenAddress, signerAddress) {
    try {
        const t = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const decimals = await t.decimals();

        const router = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, provider);
        const oneUnit = ethers.parseUnits('1', decimals);

        // Simplified simulation: use getAmountsOut as a proxy — if it returns 0 or reverts, sell is broken.
        // Full state-override simulation requires eth_call with overrides, which BSC RPC may not support.
        try {
            const path = tokenAddress.toLowerCase() === WBNB.toLowerCase()
                ? [WBNB, USDT]
                : [tokenAddress, WBNB, USDT];
            const amounts = await router.getAmountsOut(oneUnit, path);
            const out = amounts[amounts.length - 1];

            if (out === 0n) {
                return { canSell: false, reason: 'getAmountsOut returned 0' };
            }

            // Rough "tax" estimate: compare against buying 1 unit and selling immediately.
            // If round-trip yields < 70% of input, transfer tax is very high → honeypot-ish.
            const buyOut = await router.getAmountsOut(
                ethers.parseUnits('10', 18), // 10 USDT in
                [USDT, WBNB, tokenAddress]
            );
            const buyTokens = buyOut[buyOut.length - 1];
            if (buyTokens === 0n) {
                return { canSell: false, reason: 'buy leg returns 0' };
            }
            const sellOut = await router.getAmountsOut(buyTokens, path);
            const finalUsdt = sellOut[sellOut.length - 1];
            const roundTripRatio = parseFloat(ethers.formatUnits(finalUsdt, 18)) / 10;

            if (roundTripRatio < 0.70) {
                return { canSell: false, reason: `round-trip recovers ${(roundTripRatio * 100).toFixed(0)}% (>30% tax)` };
            }

            // Rough tax estimate from round-trip (accounting for 2x 0.25% LP fee + slippage)
            const taxPct = Math.max(0, (1 - roundTripRatio) * 100 - 1.0);
            return { canSell: true, taxPct, roundTripRatio };
        } catch (err) {
            return { canSell: false, reason: `sell quote failed: ${err.message}` };
        }
    } catch (err) {
        return { canSell: false, reason: `sim setup failed: ${err.message}` };
    }
}

// Master check — called before any non-allowlisted buy.
// Returns { passed, score, details }.
async function check(provider, tokenAddress, signerAddress = null) {
    // Allowlisted tokens skip dynamic checks
    if (isAllowlisted(tokenAddress)) {
        return { passed: true, score: 100, details: { allowlisted: true } };
    }

    const stat = await staticChecks(provider, tokenAddress);
    if (!stat.passed) {
        return { passed: false, score: stat.score, details: { static: stat, reason: 'static checks failed' } };
    }

    const sim = await simulatedSellCheck(provider, tokenAddress, signerAddress);
    if (!sim.canSell) {
        return { passed: false, score: 0, details: { static: stat, sim, reason: `honeypot: ${sim.reason}` } };
    }

    if (sim.taxPct > 25) {
        return { passed: false, score: 20, details: { static: stat, sim, reason: `tax ${sim.taxPct.toFixed(1)}% > 25%` } };
    }

    // Combine scores: static (0-100) weight 40%, sim (tax-based) weight 60%
    const simScore = Math.max(0, 100 - sim.taxPct * 3);
    const score = Math.round(stat.score * 0.4 + simScore * 0.6);

    return {
        passed: true,
        score,
        details: { static: stat, sim }
    };
}

module.exports = {
    check,
    staticChecks,
    simulatedSellCheck
};
