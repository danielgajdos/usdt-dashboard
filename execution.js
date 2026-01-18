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
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)'
];

async function approveToken(signer, tokenAddress) {
    try {
        const tokenVal = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
        const allowance = await tokenVal.allowance(signer.address, ROUTER_ADDRESS);

        if (allowance < ethers.parseEther('1000000')) { // Arbitrary large number
            console.log(`Approving ${tokenAddress}...`);
            const tx = await tokenVal.approve(ROUTER_ADDRESS, ethers.MaxUint256);
            await tx.wait();
            console.log('Approved!');
        }
    } catch (error) {
        console.error(`Approval failed for ${tokenAddress}:`, error.message);
    }
}

async function executeBuy(signer, tokenOut, amountInUSD) {
    try {
        const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);

        // 1. Ensure USDT is approved
        await approveToken(signer, USDT_ADDRESS);

        // 2. Calculate Amount In (USDT has 18 decimals on BSC)
        const amountIn = ethers.parseUnits(amountInUSD.toString(), 18); // USDT

        // 3. Get expected Output
        const path = [USDT_ADDRESS, config.WBNB_ADDRESS, tokenOut]; // USDT -> WBNB -> Token
        // Optimization: Check if direct pair exists, but usually via WBNB is safest for routing

        // Note: For now, simple path USDT -> WBNB -> Token 

        const amounts = await router.getAmountsOut(amountIn, path);
        const amountOutMin = amounts[2] * 95n / 100n; // 5% Slippage tolerance

        console.log(`Swapping ${amountInUSD} USDT for ${tokenOut}...`);

        const tx = await router.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            signer.address,
            Math.floor(Date.now() / 1000) + 60 * 10 // 10 mins deadline
        );

        console.log(`Buy Tx Sent: ${tx.hash}`);
        const receipt = await tx.wait();

        return { success: true, txHash: receipt.hash, amountOut: amounts[2] };

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
        const path = [tokenIn, config.WBNB_ADDRESS, USDT_ADDRESS];

        // Estimate output
        const amounts = await router.getAmountsOut(balance, path);
        const amountOutMin = amounts[2] * 90n / 100n; // 10% Slippage for sells (safety)

        console.log(`Selling ${balance} of ${tokenIn} for USDT...`);

        const tx = await router.swapExactTokensForTokens(
            balance,
            amountOutMin,
            path,
            signer.address,
            Math.floor(Date.now() / 1000) + 60 * 10
        );

        console.log(`Sell Tx Sent: ${tx.hash}`);
        const receipt = await tx.wait();

        return { success: true, txHash: receipt.hash, amountOut: amounts[2] };

    } catch (error) {
        console.error('Sell Execution Failed:', error);
        return { success: false, error: error.message };
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

        // SAFE MODE: Set amountOutMin to 98% of estimate (Slippage Protection)
        const amountOutMinSafe = amounts[amounts.length - 1] * 98n / 100n;

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
