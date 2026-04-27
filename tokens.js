// Curated BSC token universe for momentum trading.
// Every token here is allowlisted: deep pools, long-established, verified contracts.
// Allowlisted tokens skip dynamic honeypot checks.
// New tokens: verify address on BscScan, confirm liquidity > $1M, confirm >6-month age.

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';

const TOKENS = [
    {
        symbol: 'CAKE',
        address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        decimals: 18,
        minLiquidityUsd: 5_000_000,
        allowlisted: true,
        binanceSymbol: 'CAKEUSDT'    // Binance CEX ticker for real-time price feed
    },
    {
        symbol: 'XVS',
        address: '0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63',
        decimals: 18,
        minLiquidityUsd: 1_000_000,
        allowlisted: true,
        binanceSymbol: 'XVSUSDT'
    },
    {
        symbol: 'BSW',
        address: '0x965F527D9159dCe6288a2219DB51fc6Eef120dD1',
        decimals: 18,
        minLiquidityUsd: 1_000_000,
        allowlisted: true,
        binanceSymbol: null           // Not listed on Binance; falls back to on-chain quote
    },
    {
        symbol: 'ALPACA',
        address: '0x8F0528cE5eF7B51152A59745bEfDD91D97091d2F',
        decimals: 18,
        minLiquidityUsd: 500_000,
        allowlisted: true,
        binanceSymbol: 'ALPACAUSDT'
    },
    {
        symbol: 'ANKR',
        address: '0xf307910A4c7bbc79691fD374889b36d8531B08e3',
        decimals: 18,
        minLiquidityUsd: 500_000,
        allowlisted: true,
        binanceSymbol: 'ANKRUSDT'
    }
];

const BY_ADDRESS = Object.fromEntries(
    TOKENS.map(t => [t.address.toLowerCase(), t])
);

const BY_SYMBOL = Object.fromEntries(
    TOKENS.map(t => [t.symbol, t])
);

function isAllowlisted(address) {
    const t = BY_ADDRESS[address.toLowerCase()];
    return !!(t && t.allowlisted);
}

function getToken(address) {
    return BY_ADDRESS[address.toLowerCase()] || null;
}

module.exports = {
    TOKENS,
    BY_ADDRESS,
    BY_SYMBOL,
    WBNB,
    USDT,
    BUSD,
    isAllowlisted,
    getToken
};
