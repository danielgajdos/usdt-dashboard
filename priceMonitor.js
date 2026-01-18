const { ethers } = require('ethers');
const config = require('./config');

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
];

async function checkArbitrage(provider, logCallback) {
    try {
        const router = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, provider);

        const path = [
            config.TOKENS.WBNB,
            config.TOKENS.BUSD,
            config.TOKENS.USDT,
            config.TOKENS.WBNB
        ];

        // Use a standard amount for checking (e.g. the investment amount from config)
        const amountIn = ethers.parseEther(config.INVESTMENT_AMOUNT);

        // logCallback(`Scanning path: ${path.join('->')} with ${config.INVESTMENT_AMOUNT} WBNB...`, 'info');

        const amounts = await router.getAmountsOut(amountIn, path);
        const amountOut = amounts[amounts.length - 1];

        // Calculate Profit
        // Profit = Output - Input
        // We need to compare BigInts
        const profit = amountOut - amountIn;
        const profitEth = parseFloat(ethers.formatEther(profit));

        // Calculate Percentage
        const inputEth = parseFloat(config.INVESTMENT_AMOUNT);
        const profitPercent = (profitEth / inputEth) * 100;

        if (profitPercent > config.MIN_PROFIT_PERCENT) {
            logCallback(`Opportunity Found! Profit: ${profitPercent.toFixed(4)}% (${profitEth.toFixed(6)} BNB)`, 'success');
            return true;
        }

        // Optional: Log close calls?
        // if (profitPercent > -0.5) logCallback(`Close call: ${profitPercent.toFixed(4)}%`, 'info');

        return false;

    } catch (error) {
        // logCallback(`Price Monitor Error: ${error.message}`, 'error');
        // Don't spam errors on every check
        return false;
    }
}

module.exports = { checkArbitrage };
