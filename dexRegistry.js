const { ethers } = require('ethers');
const { WBNB, USDT } = require('./tokens');

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
        feeBps: 10   // Biswap 0.10% fee
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

// Quote amountOut for a path on a given DEX. Returns null on failure (pool missing, etc).
async function quote(provider, dexKey, path, amountIn) {
    try {
        const router = getRouter(provider, dexKey);
        const amounts = await router.getAmountsOut(amountIn, path);
        return amounts[amounts.length - 1];
    } catch {
        return null;
    }
}

// Standard path builders for buying/selling via WBNB hop.
function buyPath(tokenOut) {
    if (tokenOut.toLowerCase() === WBNB.toLowerCase()) return [USDT, WBNB];
    return [USDT, WBNB, tokenOut];
}

function sellPath(tokenIn) {
    if (tokenIn.toLowerCase() === WBNB.toLowerCase()) return [WBNB, USDT];
    return [tokenIn, WBNB, USDT];
}

module.exports = {
    DEXES,
    ROUTER_ABI,
    getRouter,
    quote,
    buyPath,
    sellPath
};
