const { ethers } = require('ethers');
const config = require('./config');

const ROUTER_ADDRESS = '0x10ED43C718714eb63d5aA57B78B54704E256024E'; // PCS V2 Router
const USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function balanceOf(address account) external view returns (uint256)'
];

const ROUTER_ABI = [
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external',
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)'
];

async function approveToken(signer, tokenAddress) {
    try {
        const tokenVal = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
        const allowance = await tokenVal.allowance(signer.address, ROUTER_ADDRESS);

        if (allowance < ethers.parseEther('1000000')) {
            console.log(`Approving ${tokenAddress}...`);
            const tx = await tokenVal.approve(ROUTER_ADDRESS, ethers.MaxUint256);
            await tx.wait();
            console.log('Approved!');
        }
    } catch (error) {
        console.error(`Approval failed for ${tokenAddress}:`, error.message);
        throw error; // Re-throw to stop execution!
    }
}

async function executeBuy(signer, tokenOut, amountInUSD) {
    try {
        const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);

        // 0. Check Balance BEFORE Approve/Trade
        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, signer);
        const balance = await usdtContract.balanceOf(signer.address);
        const amountIn = ethers.parseUnits(amountInUSD.toString(), 18); // USDT on BSC is 18 decimals

        if (balance < amountIn) {
            return { success: false, error: `Insufficient USDT Balance: ${ethers.formatUnits(balance, 18)} < ${amountInUSD}` };
        }

        // 1. Ensure USDT is approved
        await approveToken(signer, USDT_ADDRESS);

        // 2. Amount In already calculated above

        // 3. Get expected Output
        let path = [USDT_ADDRESS, config.TOKENS.WBNB, tokenOut]; // Default: USDT -> WBNB -> Token

        // Fix for IDENTICAL_ADDRESSES if buying WBNB
        if (tokenOut.toLowerCase() === config.TOKENS.WBNB.toLowerCase()) {
            path = [USDT_ADDRESS, config.TOKENS.WBNB];
        }

        // Optimization: Check if direct pair exists, but usually via WBNB is safest for routing

        // Note: For now, simple path USDT -> WBNB -> Token 

        const amounts = await router.getAmountsOut(amountIn, path);
        // Use 10% Slippage to handle Tax Tokens (Fee-On-Transfer)
        const amountOutMin = amounts[amounts.length - 1] * 90n / 100n;

        console.log(`Swapping ${amountInUSD} USDT for ${tokenOut}...`);

        // Use SupportingFeeOnTransferTokens to avoid reverts on tax tokens
        const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amountIn,
            amountOutMin,
            path,
            signer.address,
            Math.floor(Date.now() / 1000) + 60 * 10 // 10 mins deadline
        );

        console.log(`Buy Tx Sent: ${tx.hash}`);
        const receipt = await tx.wait();

        return { success: true, txHash: receipt.hash, amountOut: amounts[amounts.length - 1] };

    } catch (error) {
        console.error('Buy Execution Failed:', error);
        return { success: false, error: error.message };
    }
}

async function executeSell(signer, tokenIn) {
    try {
        const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);
        const tokenVal = new ethers.Contract(tokenIn, ERC20_ABI, signer);

        // 1. Check Balance
        const balance = await tokenVal.balanceOf(signer.address);
        if (balance === 0n) return { success: false, reason: 'No balance' };

        // 2. Approve
        await approveToken(signer, tokenIn);

        // 3. Swap Token -> WBNB -> USDT
        let path = [tokenIn, config.TOKENS.WBNB, USDT_ADDRESS];

        // Fix for IDENTICAL_ADDRESSES if selling WBNB
        if (tokenIn.toLowerCase() === config.TOKENS.WBNB.toLowerCase()) {
            path = [config.TOKENS.WBNB, USDT_ADDRESS];
        }

        // Estimate output
        const amounts = await router.getAmountsOut(balance, path);
        // Use 10% Slippage for Sells too
        const amountOutMin = amounts[amounts.length - 1] * 90n / 100n;

        console.log(`Selling ${balance} of ${tokenIn} for USDT...`);

        // Use SupportingFeeOnTransferTokens
        const tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            balance,
            amountOutMin,
            path,
            signer.address,
            Math.floor(Date.now() / 1000) + 60 * 10
        );

        console.log(`Sell Tx Sent: ${tx.hash}`);
        const receipt = await tx.wait();

        return { success: true, txHash: receipt.hash, amountOut: amounts[amounts.length - 1] };

    } catch (error) {
        console.error('Sell Execution Failed:', error);
        return { success: false, error: error.message || error.toString() }; // Fix for undefined error
    }
}

async function getUSDTBalance(signer) {
    try {
        const tokenVal = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, signer);
        const balance = await tokenVal.balanceOf(signer.address);
        // USDT on BSC has 18 decimals
        return ethers.formatUnits(balance, 18);
    } catch (error) {
        console.error('Failed to get USDT Balance:', error.message);
        return '0.00';
    }
}

async function executeArbitrage(signer, logCallback) {
    try {
        const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);

        // Check Balances
        const bnbBalance = await signer.provider.getBalance(signer.address);
        // We know getUSDTBalance exists, but it returns string. Let's get BigInt here or use helper.
        const usdtContract = new ethers.Contract(USDT_ADDRESS, ERC20_ABI, signer);
        const usdtBalance = await usdtContract.balanceOf(signer.address);

        // Lower Gas Reserve for "Aggressive" mode: 0.003 BNB (~$1.50)
        // Ensure we have enough gas to just SEND the tx (~0.001)
        const gasReserve = ethers.parseEther('0.003');
        const minGasForTx = ethers.parseEther('0.001');

        if (bnbBalance < minGasForTx) {
            logCallback(`CRITICAL: Not enough BNB for gas! (${ethers.formatEther(bnbBalance)} < 0.001)`, 'error');
            // TODO: We could upgrade this to sell USDT for BNB if we find a way, but we need gas to do THAT too.
            return { success: false };
        }

        let tradeType = 'BNB';
        let amountIn = 0n;
        let path = [];

        // Decision Logic: Prefer using BNB if we have plenty, otherwise use USDT
        if (bnbBalance > gasReserve + ethers.parseEther('0.02')) {
            // We have > 0.023 BNB. Trade BNB.
            tradeType = 'BNB';
            amountIn = (bnbBalance - gasReserve) / 2n; // 50%
            path = [config.TOKENS.WBNB, config.TOKENS.BUSD, config.TOKENS.USDT, config.TOKENS.WBNB];

        } else if (usdtBalance > ethers.parseUnits('5', 18)) {
            // We have > 5 USDT. Trade USDT.
            tradeType = 'USDT';
            amountIn = usdtBalance / 2n; // 50%
            path = [config.TOKENS.USDT, config.TOKENS.WBNB, config.TOKENS.BUSD, config.TOKENS.USDT];

        } else {
            // Try to scrape somewhat lower BNB?
            if (bnbBalance > gasReserve) {
                tradeType = 'BNB';
                amountIn = (bnbBalance - gasReserve) / 2n;
                path = [config.TOKENS.WBNB, config.TOKENS.BUSD, config.TOKENS.USDT, config.TOKENS.WBNB];
            } else {
                logCallback('Insufficient Capital (Low BNB & Low USDT).', 'error');
                return { success: false };
            }
        }

        logCallback(`Executing ${tradeType} Loop with ${tradeType === 'BNB' ? ethers.formatEther(amountIn) : ethers.formatUnits(amountIn, 18)}...`, 'info');

        // FIXED: Calculate amounts first!
        const amounts = await router.getAmountsOut(amountIn, path);

        // --- SAFE MODE CHECKS ---
        if (config.SAFE_MODE) {
            // 1. Enforce Max Trade Amount (Re-calculate amountIn if needed)
            // Approximate BNB Price for sizing (Assume $300 if unknown, or safe default)
            // Realistically we should fetch it, but for safety we can just cap amountIn directly.
            // 15 USD / 300 = 0.05 BNB. Let's be very conservative.
            // Better: use the stablecoin balance check to limit amountIn for USDT trades.

            const maxUsd = BigInt(config.SAFE_CONFIG.MAX_TRADE_AMOUNT_USD) * (10n ** 18n); // 15 * 10^18

            if (tradeType === 'USDT') {
                if (amountIn > maxUsd) {
                    amountIn = maxUsd;
                    logCallback(`[SAFE MODE] Capping Trade Size to ${config.SAFE_CONFIG.MAX_TRADE_AMOUNT_USD} USDT`, 'info');
                    // Recalculate output with new amount
                    // amounts = await router.getAmountsOut(amountIn, path); // Can't reassign const, need to handle this
                }
            } else if (tradeType === 'BNB') {
                // Rough calc: 1 BNB = $500 (Safety Buffer). 15 / 500 = 0.03 BNB
                const maxBnb = ethers.parseEther('0.03');
                if (amountIn > maxBnb) {
                    amountIn = maxBnb;
                    logCallback(`[SAFE MODE] Capping Trade Size to 0.03 BNB (~$15)`, 'info');
                }
            }
        }

        // Re-fetch amounts in case amountIn changed
        const finalAmounts = await router.getAmountsOut(amountIn, path);
        const amountOut = finalAmounts[finalAmounts.length - 1];

        // 2. Check Profit Requirement (Double Check)
        const profit = amountOut - amountIn;
        const profitPercent = (Number(profit) / Number(amountIn)) * 100;

        if (config.SAFE_MODE && profitPercent < config.SAFE_CONFIG.MIN_PROFIT_PERCENT) {
            logCallback(`[SAFE MODE] Profit ${profitPercent.toFixed(4)}% < ${config.SAFE_CONFIG.MIN_PROFIT_PERCENT}%. Aborting.`, 'warning');
            return { success: false, reason: 'Profit too low for Safe Mode' };
        }

        // SAFE MODE: Set amountOutMin based on strict slippage
        const slippage = config.SAFE_MODE ? BigInt(config.SAFE_CONFIG.SLIPPAGE_PERCENT) : 2n; // 2% or standard
        const amountOutMinSafe = amountOut * (100n - slippage) / 100n;

        let tx;
        // Keep gas limit reasonable but allow for complex routing
        const txOverrides = { gasLimit: 500000 };
        if (tradeType === 'BNB') {
            txOverrides.value = amountIn;
            tx = await router.swapExactETHForTokens(
                amountOutMinSafe,
                path,
                signer.address,
                Math.floor(Date.now() / 1000) + 60,
                txOverrides
            );
        } else {
            // USDT Entry
            // 1. Approve (Force check? Logic looks ok)
            const allowance = await usdtContract.allowance(signer.address, ROUTER_ADDRESS);
            if (allowance < amountIn) {
                logCallback('Approving USDT...', 'info');
                const approveTx = await usdtContract.approve(ROUTER_ADDRESS, ethers.MaxUint256);
                await approveTx.wait();
            }

            // 2. Swap
            tx = await router.swapExactTokensForTokens(
                amountIn,
                amountOutMinSafe,
                path,
                signer.address,
                Math.floor(Date.now() / 1000) + 60,
                txOverrides
            );
        }

        logCallback(`Arb Tx Sent: ${tx.hash}`, 'success');
        const receipt = await tx.wait();
        logCallback(`Arb Tx Confirmed! Gas: ${receipt.gasUsed}`, 'success');

        return { success: true, txHash: receipt.hash };

    } catch (error) {
        logCallback(`Arb Execution Failed: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

module.exports = { executeBuy, executeSell, getUSDTBalance, executeArbitrage };
