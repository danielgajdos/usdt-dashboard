const { ethers } = require('ethers');
const chalk = require('chalk');
const config = require('./config');

const FACTORY_ABI = [
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint)'
];

async function startSniper(provider, logCallback) {
    const factory = new ethers.Contract(config.FACTORY_ADDRESS, FACTORY_ABI, provider);

    logCallback('Initializing Liquidity Sniper...', 'info');
    logCallback(`Listening to Factory: ${config.FACTORY_ADDRESS}`, 'info');

    // Listen for PairCreated events
    factory.on('PairCreated', (token0, token1, pairAddress) => {
        // Check if one of the tokens is WBNB
        let isWBNBInfo = false;
        let otherToken = '';

        if (token0.toLowerCase() === config.TOKENS.WBNB.toLowerCase()) {
            isWBNBInfo = true;
            otherToken = token1;
        } else if (token1.toLowerCase() === config.TOKENS.WBNB.toLowerCase()) {
            isWBNBInfo = true;
            otherToken = token0;
        }

        if (isWBNBInfo) {
            const msg = `[SNIPER] New WBNB Pair Detected! Token: ${otherToken} | Pair: ${pairAddress}`;
            logCallback(msg, 'success');
            console.log(chalk.green(msg));

            // In a real bot, you would trigger a 'simulated buy' here
        } else {
            const msg = `[SNIPER] New Pair (No WBNB): ${token0} / ${token1}`;
            logCallback(msg, 'info');
        }
    });
}

module.exports = { startSniper };
