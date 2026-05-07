const { ethers } = require('ethers');
const { WBNB, USDT } = require('./tokens');

// ============================================================================
// PancakeSwap V2 (legacy AMM) — used by default for BSC-native pairs.
// ============================================================================

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
    'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
];

const DEXES = {
    PCS_V2: {
        name: 'PancakeSwap V2',
        router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
        factory: '0xcA143Ce32Fe78f1f7019d7d551a607b003182036',
        feeBps: 25
    },
    BISWAP: {
        name: 'Biswap',
        router: '0x3a6d8cA21a1427ef1be3b73c5e6AfCC88E7cA1F9',
        factory: '0x858E3312ed3A876947EA49d572A7C42DE08af7EE',
        feeBps: 10
    },
    APESWAP: {
        name: 'ApeSwap',
        router: '0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b',
        factory: '0x0841BD0B734E4F5853f0dD8d7Ea041c241fb0Da6',
        feeBps: 20
    }
};

function getRouter(provider, dexKey = 'PCS_V2') {
    const dex = DEXES[dexKey];
    if (!dex) throw new Error(`Unknown DEX: ${dexKey}`);
    return new ethers.Contract(dex.router, ROUTER_ABI, provider);
}

// V2 quote — returns BigInt amountOut or null on failure.
async function quote(provider, dexKey, path, amountIn) {
    try {
        const router = getRouter(provider, dexKey);
        const amounts = await router.getAmountsOut(amountIn, path);
        return amounts[amounts.length - 1];
    } catch {
        return null;
    }
}

// Standard V2 path builders for buying/selling via WBNB hop.
function buyPath(tokenOut) {
    if (tokenOut.toLowerCase() === WBNB.toLowerCase()) return [USDT, WBNB];
    return [USDT, WBNB, tokenOut];
}

function sellPath(tokenIn) {
    if (tokenIn.toLowerCase() === WBNB.toLowerCase()) return [WBNB, USDT];
    return [tokenIn, WBNB, USDT];
}

// ============================================================================
// PancakeSwap V3 (concentrated liquidity) — for major pairs (BTCB, SOL, ETH)
// where 2024+ liquidity has migrated off V2.
// ============================================================================

const PCS_V3 = {
    name: 'PancakeSwap V3',
    router: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'
};

// V3 fee tiers (in 1e6-units of pool fee). Try all four; deepest pool wins.
const V3_FEE_TIERS = [100, 500, 2500, 10000]; // 0.01%, 0.05%, 0.25%, 1%

const V3_QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'
];

const V3_ROUTER_ABI = [
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)'
];

// Quote V3 single-hop at a specific fee tier. Returns BigInt or null.
async function quoteV3SingleHop(provider, tokenIn, tokenOut, amountIn, fee) {
    try {
        const quoter = new ethers.Contract(PCS_V3.quoter, V3_QUOTER_ABI, provider);
        // V3 quoter is technically state-mutating; use staticCall to read result
        const result = await quoter.quoteExactInputSingle.staticCall({
            tokenIn,
            tokenOut,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0
        });
        return result[0]; // amountOut
    } catch {
        return null;
    }
}

// Try all V3 fee tiers; return the best { fee, amountOut } or null.
async function quoteV3Best(provider, tokenIn, tokenOut, amountIn) {
    const results = await Promise.all(
        V3_FEE_TIERS.map(async fee => ({
            fee,
            out: await quoteV3SingleHop(provider, tokenIn, tokenOut, amountIn, fee)
        }))
    );
    let best = null;
    for (const r of results) {
        if (r.out !== null && r.out > 0n) {
            if (!best || r.out > best.out) best = r;
        }
    }
    return best ? { fee: best.fee, amountOut: best.out } : null;
}

// Compare V2 multi-hop and V3 single-hop quotes; return the venue with the
// better amountOut. Used by both the depth check and the executor.
// Returns:
//   { venue: 'V2', amountOut, path }            for V2 multi-hop USDT-WBNB-token
//   { venue: 'V3', amountOut, fee }             for V3 single-hop
//   null                                        if neither has liquidity
async function bestQuote(provider, tokenIn, tokenOut, amountIn) {
    // V2 path: USDT-WBNB-token (or 2-hop if one leg is WBNB)
    let v2Path;
    const inLow = tokenIn.toLowerCase();
    const outLow = tokenOut.toLowerCase();
    const wbnbLow = WBNB.toLowerCase();
    const usdtLow = USDT.toLowerCase();

    if (inLow === usdtLow) {
        v2Path = outLow === wbnbLow ? [USDT, WBNB] : [USDT, WBNB, tokenOut];
    } else if (outLow === usdtLow) {
        v2Path = inLow === wbnbLow ? [WBNB, USDT] : [tokenIn, WBNB, USDT];
    } else {
        v2Path = [tokenIn, WBNB, tokenOut];
    }

    const [v2Out, v3Best] = await Promise.all([
        quote(provider, 'PCS_V2', v2Path, amountIn),
        quoteV3Best(provider, tokenIn, tokenOut, amountIn)
    ]);

    const v2OutBn = v2Out || 0n;
    const v3OutBn = v3Best?.amountOut || 0n;

    if (v2OutBn === 0n && v3OutBn === 0n) return null;

    if (v3OutBn > v2OutBn) {
        return { venue: 'V3', amountOut: v3OutBn, fee: v3Best.fee };
    }
    return { venue: 'V2', amountOut: v2OutBn, path: v2Path };
}

module.exports = {
    DEXES,
    ROUTER_ABI,
    PCS_V3,
    V3_QUOTER_ABI,
    V3_ROUTER_ABI,
    V3_FEE_TIERS,
    getRouter,
    quote,
    quoteV3SingleHop,
    quoteV3Best,
    bestQuote,
    buyPath,
    sellPath
};
