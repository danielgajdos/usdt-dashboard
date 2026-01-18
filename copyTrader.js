const { ethers } = require('ethers');
const chalk = require('chalk');
const config = require('./config');

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
]; // Corrected minimal ABI for this file's usage or similar

// Note: The original copyTrader.js had 'const iface = new ethers.Interface(ROUTER_ABI);'
// I need to make sure ROUTER_ABI is fully defined if it uses parseTransaction, which implies it needs function definitions.
// However, the original file I saw in `cat` had `];` at the top, implying the ABI was there.
// I will use a fuller ABI to be safe for parsing swaps.
const FULL_ROUTER_ABI = [
    'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapETHForExactTokens(uint amountOut, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    'function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)'
];

const iface = new ethers.Interface(FULL_ROUTER_ABI);

async function startCopyTrader(provider, logCallback, executeTradeCallback, getHoldingsCallback) {
    logCallback('Initializing Copy Trader...', 'info');
    logCallback(`Tracking ${config.TARGET_WALLETS.length} Smart Money Wallets`, 'info');

    // Normalize wallets for comparison
    const watchedWallets = config.TARGET_WALLETS.map(w => w.toLowerCase());

    // Monitor every new block
    provider.on('block', async (blockNumber) => {
        try {
            // Get block with full transactions
            const block = await provider.getBlock(blockNumber, true);
            const myHoldings = getHoldingsCallback ? getHoldingsCallback() : [];

            if (block && block.prefetchedTransactions) {
                for (const tx of block.prefetchedTransactions) {
                    if (tx.from && watchedWallets.includes(tx.from.toLowerCase())) {

                        // 1. Identify Trader
                        const walletIdx = watchedWallets.indexOf(tx.from.toLowerCase());
                        const alias = `Trader #${walletIdx + 1}`;

                        // 2. Decode Transaction to see what they bought
                        let action = "UNKNOWN";
                        let token = "Unknown";
                        let type = "NONE";

                        try {
                            // Ignore interactions not with Router
                            if (tx.to && tx.to.toLowerCase() === config.ROUTER_ADDRESS.toLowerCase()) {
                                const decoded = iface.parseTransaction({ data: tx.data, value: tx.value });

                                if (decoded && decoded.args.path && decoded.args.path.length > 0) {
                                    const path = decoded.args.path;
                                    const inputToken = path[0];
                                    const outputToken = path[path.length - 1];

                                    // Check BUY (Input is WBNB or Stable)
                                    // Simplified: If output is NOT WBNB/BUSD/USDT, assume BUY
                                    // Check SELL (Input IS a token we hold)

                                    if (myHoldings.includes(inputToken.toLowerCase())) {
                                        // THEY ARE SELLING A TOKEN WE HOLD!
                                        action = "SELL";
                                        token = inputToken;
                                        type = "EXIT";
                                    } else {
                                        // Assume BUY if not a known stablecoin (simplified)
                                        // Or just check if we don't hold it yet
                                        action = "BUY";
                                        token = outputToken;
                                        type = "ENTRY";
                                    }
                                }
                            }
                        } catch (decodeErr) {
                            // Not a standard swap or different ABI
                        }

                        // 3. Trigger Simulation
                        if (executeTradeCallback && action !== "UNKNOWN") {
                            executeTradeCallback(type, token, alias, tx.hash);
                        }
                    }
                }
            }
        } catch (err) {
            console.error(chalk.red('[COPY] Error processing block:', err.message));
        }
    });
}

module.exports = { startCopyTrader };
