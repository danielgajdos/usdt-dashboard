require('dotenv').config();

module.exports = {
    // BSC Public RPC Endpoint (Free, might be slow/rate-limited)
    RPC_URL: process.env.RPC_URL || 'https://bsc-dataseed.binance.org/',

    // Wallet Private Key (Required for writing transactions, optional for reading)
    PRIVATE_KEY: process.env.PRIVATE_KEY,

    // PancakeSwap V2 Router Address
    ROUTER_ADDRESS: '0x10ED43C718714eb63d5aA57B78B54704E256024E',

    // PancakeSwap V2 Factory Address
    FACTORY_ADDRESS: '0xcA143Ce32Fe78f1f7019d7d551a607b003182036',

    // Token Addresses (BSC Mainnet)
    TOKENS: {
        WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        USDT: '0x55d398326f99059fF775485246999027B3197955'
    },

    COPY_MODE: process.env.COPY_MODE === 'true',
    TARGET_WALLETS: process.env.TARGET_WALLETS
        ? process.env.TARGET_WALLETS.split(',').filter(w => w.length > 0)
        : [
            '0xB828DBa1250956123599F7753080202b2114C15F', // Top Trader #1
            '0x4D87e3993cbDd65ee899DA3a77Fd0e3C043471b8', // Top Trader #2
            '0x6B582301c5dcF172B529D9e1F113a2742ab68F99'  // Top Trader #3
        ],

    PRIVATE_KEY: process.env.PRIVATE_KEY, // Real Wallet Key
    SIMULATION_MODE: process.env.SIMULATION_MODE !== 'false', // Default true unless explicitly false

    MIN_PROFIT_PERCENT: 0.5, // Minimum profit percentage to trigger a trade
    INVESTMENT_AMOUNT: '0.01' // Amount of WBNB to trade
};
