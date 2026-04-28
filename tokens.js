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
        // Trust Wallet Token — BSC-native, high Binance volume, active PCS V2 pool
        symbol: 'TWT',
        address: '0x4B0F1812e5Df2A09796481Ff14017e6005508003',
        decimals: 18,
        minLiquidityUsd: 1_000_000,
        allowlisted: true,
        binanceSymbol: 'TWTUSDT'
    },
    {
        // Radiant Capital — BSC cross-chain lending, active Binance listing, high BSC TVL
        symbol: 'RDNT',
        address: '0xf7DE7E8A6bd59ED41a4b5fe50278b3B7f31384dF',
        decimals: 18,
        minLiquidityUsd: 1_000_000,
        allowlisted: true,
        binanceSymbol: 'RDNTUSDT'
    },
    {
        // Lista DAO — PancakeSwap backing protocol, launched 2024, active on Binance
        symbol: 'LISTA',
        address: '0xFceB31A79F71AC9CBDCF853519c1b12D379EdC46',
        decimals: 18,
        minLiquidityUsd: 1_000_000,
        allowlisted: true,
        binanceSymbol: 'LISTAUSDT'
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
