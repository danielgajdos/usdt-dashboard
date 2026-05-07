const { ethers } = require('ethers');
const config = require('./config');
const { WBNB, USDT } = require('./tokens');
const {
    buyPath,
    sellPath,
    ROUTER_ABI,
    PCS_V3,
    V3_ROUTER_ABI,
    quote,
    quoteV3Best
} = require('./dexRegistry');
const marketData = require('./marketData');

const ROUTER_ADDRESS = config.ROUTER_ADDRESS;          // PCS V2 router
const V3_ROUTER_ADDRESS = PCS_V3.router;                // PCS V3 router

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function balanceOf(address account) external view returns (uint256)',
    'function decimals() external view returns (uint8)'
];

// Approve `tokenAddress` for `spenderAddress` (V2 or V3 router) if allowance is low.
// Cached approvals on chain mean this is a one-time cost per (token, router) pair.
async function approveToken(signer, tokenAddress, spenderAddress = ROUTER_ADDRESS) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const allowance = await token.allowance(signer.address, spenderAddress);
    if (allowance < ethers.parseEther('1000000')) {
        const tx = await token.approve(spenderAddress, ethers.MaxUint256);
        await tx.wait();
    }
}

async function getUSDTBalance(signer) {
    try {
        const token = new ethers.Contract(USDT, ERC20_ABI, signer);
        const bal = await token.balanceOf(signer.address);
        return ethers.formatUnits(bal, 18);
    } catch (err) {
        console.error('Failed to get USDT balance:', err.message);
        return '0.00';
    }
}

// Pick V2 or V3 based on the cached venue from marketData's depth check.
// If no cached venue (first-ever execution), default to V2.
function venueFor(tokenAddress) {
    const v = marketData.getVenue(tokenAddress);
    if (v && (v.venue === 'V3' || v.venue === 'V2')) return v;
    return { venue: 'V2', fee: null };
}

// Execute a Decision against the chain.
// Returns { success, txHash, amountOut, amountOutFormatted, entryPrice, amountTokens } or { success: false, error }.
// Executor trusts the Decision — it does NOT re-check profitability. It only enforces slippage bounds.
async function executeDecision(signer, decision) {
    if (config.SIMULATION_MODE) {
        return _simulateDecision(signer, decision);
    }

    try {
        if (decision.action === 'ENTER') {
            return await _executeBuy(signer, decision);
        } else if (decision.action === 'EXIT') {
            return await _executeSell(signer, decision);
        }
        return { success: false, error: `Unknown action: ${decision.action}` };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
}

async function _executeBuy(signer, decision) {
    const venueInfo = venueFor(decision.token);
    if (venueInfo.venue === 'V3') {
        return _executeBuyV3(signer, decision, venueInfo.fee);
    }
    return _executeBuyV2(signer, decision);
}

async function _executeSell(signer, decision) {
    const venueInfo = venueFor(decision.token);
    if (venueInfo.venue === 'V3') {
        return _executeSellV3(signer, decision, venueInfo.fee);
    }
    return _executeSellV2(signer, decision);
}

// ------------------------- V2 ENTRY -------------------------
async function _executeBuyV2(signer, decision) {
    const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);
    const usdt = new ethers.Contract(USDT, ERC20_ABI, signer);
    const amountIn = ethers.parseUnits(decision.sizeEur.toFixed(6), 18);

    const balance = await usdt.balanceOf(signer.address);
    if (balance < amountIn) {
        return { success: false, error: `Insufficient USDT: ${ethers.formatUnits(balance, 18)} < €${decision.sizeEur}` };
    }
    await approveToken(signer, USDT, ROUTER_ADDRESS);

    const path = buyPath(decision.token);
    const amounts = await router.getAmountsOut(amountIn, path);
    const expectedOut = amounts[amounts.length - 1];

    const slippageBps = BigInt(Math.round(config.COSTS.LIVE_SLIPPAGE_TOLERANCE_PCT * 100));
    const amountOutMin = expectedOut * (10000n - slippageBps) / 10000n;

    const deadline = Math.floor(Date.now() / 1000) + 60;
    const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
        amountIn, amountOutMin, path, signer.address, deadline,
        { gasLimit: 500000 }
    );
    const receipt = await tx.wait();

    const tokenContract = new ethers.Contract(decision.token, ERC20_ABI, signer);
    const decimals = await tokenContract.decimals();
    const amountTokens = parseFloat(ethers.formatUnits(expectedOut, decimals));
    const entryPrice = amountTokens > 0 ? decision.sizeEur / amountTokens : 0;

    return {
        success: true, txHash: receipt.hash, venue: 'V2',
        amountOut: expectedOut, amountTokens, entryPrice, gasUsed: receipt.gasUsed
    };
}

// ------------------------- V2 EXIT -------------------------
async function _executeSellV2(signer, decision) {
    const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);
    const token = new ethers.Contract(decision.token, ERC20_ABI, signer);

    let balance = await token.balanceOf(signer.address);
    if (decision.partial && decision.partial > 0 && decision.partial < 1) {
        balance = (balance * BigInt(Math.round(decision.partial * 10000))) / 10000n;
    }
    if (balance === 0n) return { success: false, error: 'No balance to sell' };

    await approveToken(signer, decision.token, ROUTER_ADDRESS);

    const path = sellPath(decision.token);
    const amounts = await router.getAmountsOut(balance, path);
    const expectedOut = amounts[amounts.length - 1];

    const slippageBps = BigInt(Math.round(config.COSTS.LIVE_SLIPPAGE_TOLERANCE_PCT * 100));
    const amountOutMin = expectedOut * (10000n - slippageBps) / 10000n;

    const deadline = Math.floor(Date.now() / 1000) + 60;
    const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
        balance, amountOutMin, path, signer.address, deadline,
        { gasLimit: 500000 }
    );
    const receipt = await tx.wait();

    const exitValueEur = parseFloat(ethers.formatUnits(expectedOut, 18));
    return { success: true, txHash: receipt.hash, venue: 'V2', amountOut: expectedOut, exitValueEur, gasUsed: receipt.gasUsed };
}

// ------------------------- V3 ENTRY -------------------------
// V3 is single-hop USDT→token (PCS V3 has direct USDT-token pools for majors).
// `fee` should come from venueFor(); if null, pick the deepest fee tier on the fly.
async function _executeBuyV3(signer, decision, fee) {
    const router = new ethers.Contract(V3_ROUTER_ADDRESS, V3_ROUTER_ABI, signer);
    const usdt = new ethers.Contract(USDT, ERC20_ABI, signer);
    const amountIn = ethers.parseUnits(decision.sizeEur.toFixed(6), 18);

    const balance = await usdt.balanceOf(signer.address);
    if (balance < amountIn) {
        return { success: false, error: `Insufficient USDT: ${ethers.formatUnits(balance, 18)} < €${decision.sizeEur}` };
    }
    await approveToken(signer, USDT, V3_ROUTER_ADDRESS);

    // Resolve fee tier if caller didn't pass one
    let tier = fee;
    let expectedOut = 0n;
    if (!tier) {
        const best = await quoteV3Best(signer.provider, USDT, decision.token, amountIn);
        if (!best) return { success: false, error: 'No V3 pool with liquidity' };
        tier = best.fee;
        expectedOut = best.amountOut;
    } else {
        const best = await quoteV3Best(signer.provider, USDT, decision.token, amountIn);
        expectedOut = best ? best.amountOut : 0n;
        if (best && best.fee !== tier) tier = best.fee; // re-pick if cached tier dried up
    }
    if (expectedOut === 0n) return { success: false, error: 'V3 quote returned 0' };

    const slippageBps = BigInt(Math.round(config.COSTS.LIVE_SLIPPAGE_TOLERANCE_PCT * 100));
    const amountOutMin = expectedOut * (10000n - slippageBps) / 10000n;

    const deadline = Math.floor(Date.now() / 1000) + 60;
    const params = {
        tokenIn: USDT,
        tokenOut: decision.token,
        fee: tier,
        recipient: signer.address,
        deadline,
        amountIn,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0
    };
    const tx = await router.exactInputSingle(params, { gasLimit: 500000 });
    const receipt = await tx.wait();

    const tokenContract = new ethers.Contract(decision.token, ERC20_ABI, signer);
    const decimals = await tokenContract.decimals();
    const amountTokens = parseFloat(ethers.formatUnits(expectedOut, decimals));
    const entryPrice = amountTokens > 0 ? decision.sizeEur / amountTokens : 0;

    return {
        success: true, txHash: receipt.hash, venue: 'V3', fee: tier,
        amountOut: expectedOut, amountTokens, entryPrice, gasUsed: receipt.gasUsed
    };
}

// ------------------------- V3 EXIT -------------------------
async function _executeSellV3(signer, decision, fee) {
    const router = new ethers.Contract(V3_ROUTER_ADDRESS, V3_ROUTER_ABI, signer);
    const token = new ethers.Contract(decision.token, ERC20_ABI, signer);

    let balance = await token.balanceOf(signer.address);
    if (decision.partial && decision.partial > 0 && decision.partial < 1) {
        balance = (balance * BigInt(Math.round(decision.partial * 10000))) / 10000n;
    }
    if (balance === 0n) return { success: false, error: 'No balance to sell' };

    await approveToken(signer, decision.token, V3_ROUTER_ADDRESS);

    // Resolve fee tier (use the one with deepest liquidity for the SELL direction)
    let tier = fee;
    let expectedOut = 0n;
    const best = await quoteV3Best(signer.provider, decision.token, USDT, balance);
    if (!best) return { success: false, error: 'No V3 pool with liquidity for sell' };
    tier = best.fee;
    expectedOut = best.amountOut;

    const slippageBps = BigInt(Math.round(config.COSTS.LIVE_SLIPPAGE_TOLERANCE_PCT * 100));
    const amountOutMin = expectedOut * (10000n - slippageBps) / 10000n;

    const deadline = Math.floor(Date.now() / 1000) + 60;
    const params = {
        tokenIn: decision.token,
        tokenOut: USDT,
        fee: tier,
        recipient: signer.address,
        deadline,
        amountIn: balance,
        amountOutMinimum: amountOutMin,
        sqrtPriceLimitX96: 0
    };
    const tx = await router.exactInputSingle(params, { gasLimit: 500000 });
    const receipt = await tx.wait();

    const exitValueEur = parseFloat(ethers.formatUnits(expectedOut, 18));
    return { success: true, txHash: receipt.hash, venue: 'V3', fee: tier, amountOut: expectedOut, exitValueEur, gasUsed: receipt.gasUsed };
}

// Simulation path — computes what WOULD have happened using live on-chain quotes, no tx.
async function _simulateDecision(signer, decision) {
    try {
        const provider = signer ? signer.provider : null;
        if (!provider) {
            return { success: true, txHash: '0xSIM', simulated: true };
        }
        const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

        if (decision.action === 'ENTER') {
            const amountIn = ethers.parseUnits(decision.sizeEur.toFixed(6), 18);
            const path = buyPath(decision.token);
            const amounts = await router.getAmountsOut(amountIn, path);
            const expectedOut = amounts[amounts.length - 1];

            const amountTokens = parseFloat(ethers.formatUnits(expectedOut, 18));
            const entryPrice = amountTokens > 0 ? decision.sizeEur / amountTokens : 0;

            return {
                success: true, simulated: true, txHash: '0xSIM_BUY',
                amountOut: expectedOut, amountTokens, entryPrice
            };
        } else if (decision.action === 'EXIT') {
            return {
                success: true, simulated: true, txHash: '0xSIM_SELL',
                exitValueEur: decision.simulatedExitValue || 0
            };
        }
        return { success: false, error: 'Unknown sim action' };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = {
    approveToken,
    getUSDTBalance,
    executeDecision
};
