const { ethers } = require('ethers');
const config = require('./config');
const { WBNB, USDT } = require('./tokens');
const { buyPath, sellPath, ROUTER_ABI } = require('./dexRegistry');

const ROUTER_ADDRESS = config.ROUTER_ADDRESS;

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function balanceOf(address account) external view returns (uint256)',
    'function decimals() external view returns (uint8)'
];

async function approveToken(signer, tokenAddress) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const allowance = await token.allowance(signer.address, ROUTER_ADDRESS);
    if (allowance < ethers.parseEther('1000000')) {
        const tx = await token.approve(ROUTER_ADDRESS, ethers.MaxUint256);
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
    const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);
    const usdt = new ethers.Contract(USDT, ERC20_ABI, signer);

    // USDT has 18 decimals on BSC.
    const amountIn = ethers.parseUnits(decision.sizeEur.toFixed(6), 18);

    const balance = await usdt.balanceOf(signer.address);
    if (balance < amountIn) {
        return { success: false, error: `Insufficient USDT: ${ethers.formatUnits(balance, 18)} < €${decision.sizeEur}` };
    }

    await approveToken(signer, USDT);

    const path = buyPath(decision.token);
    const amounts = await router.getAmountsOut(amountIn, path);
    const expectedOut = amounts[amounts.length - 1];

    // Strict slippage for live trading (1% default).
    const slippageBps = BigInt(Math.round(config.COSTS.LIVE_SLIPPAGE_TOLERANCE_PCT * 100));
    const amountOutMin = expectedOut * (10000n - slippageBps) / 10000n;

    const deadline = Math.floor(Date.now() / 1000) + 60;
    const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
        amountIn,
        amountOutMin,
        path,
        signer.address,
        deadline,
        { gasLimit: 500000 }
    );
    const receipt = await tx.wait();

    // We can't read exact amountOut without parsing logs; use expectedOut as the entry basis.
    // The honeypot check should have caught transfer tax already.
    const tokenContract = new ethers.Contract(decision.token, ERC20_ABI, signer);
    const decimals = await tokenContract.decimals();
    const amountTokens = parseFloat(ethers.formatUnits(expectedOut, decimals));
    const entryPrice = amountTokens > 0 ? decision.sizeEur / amountTokens : 0;

    return {
        success: true,
        txHash: receipt.hash,
        amountOut: expectedOut,
        amountTokens,
        entryPrice,
        gasUsed: receipt.gasUsed
    };
}

async function _executeSell(signer, decision) {
    const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);
    const token = new ethers.Contract(decision.token, ERC20_ABI, signer);

    let balance = await token.balanceOf(signer.address);
    if (decision.partial && decision.partial > 0 && decision.partial < 1) {
        balance = (balance * BigInt(Math.round(decision.partial * 10000))) / 10000n;
    }
    if (balance === 0n) return { success: false, error: 'No balance to sell' };

    await approveToken(signer, decision.token);

    const path = sellPath(decision.token);
    const amounts = await router.getAmountsOut(balance, path);
    const expectedOut = amounts[amounts.length - 1];

    const slippageBps = BigInt(Math.round(config.COSTS.LIVE_SLIPPAGE_TOLERANCE_PCT * 100));
    const amountOutMin = expectedOut * (10000n - slippageBps) / 10000n;

    const deadline = Math.floor(Date.now() / 1000) + 60;
    const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
        balance,
        amountOutMin,
        path,
        signer.address,
        deadline,
        { gasLimit: 500000 }
    );
    const receipt = await tx.wait();

    const exitValueEur = parseFloat(ethers.formatUnits(expectedOut, 18));

    return {
        success: true,
        txHash: receipt.hash,
        amountOut: expectedOut,
        exitValueEur,
        gasUsed: receipt.gasUsed
    };
}

// Simulation path — computes what WOULD have happened using live on-chain quotes, no tx.
async function _simulateDecision(signer, decision) {
    try {
        const provider = signer ? signer.provider : null;
        if (!provider) {
            // Pure sim with no provider: use current market price from marketData
            return { success: true, txHash: '0xSIM', simulated: true };
        }
        const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

        if (decision.action === 'ENTER') {
            const amountIn = ethers.parseUnits(decision.sizeEur.toFixed(6), 18);
            const path = buyPath(decision.token);
            const amounts = await router.getAmountsOut(amountIn, path);
            const expectedOut = amounts[amounts.length - 1];

            // Guess decimals=18 in sim; acceptable approximation
            const amountTokens = parseFloat(ethers.formatUnits(expectedOut, 18));
            const entryPrice = amountTokens > 0 ? decision.sizeEur / amountTokens : 0;

            return {
                success: true,
                simulated: true,
                txHash: '0xSIM_BUY',
                amountOut: expectedOut,
                amountTokens,
                entryPrice
            };
        } else if (decision.action === 'EXIT') {
            return {
                success: true,
                simulated: true,
                txHash: '0xSIM_SELL',
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
