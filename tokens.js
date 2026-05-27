// Curated BSC token universe for momentum trading.
// Every token here is allowlisted: deep pools, long-established, verified contracts.
// Allowlisted tokens skip dynamic honeypot checks.
// New tokens: verify address on BscScan, confirm liquidity > $1M, confirm >6-month age.

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const USDT = '0x55d398326f99059fF775485246999027B3197955';
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';

// 2026-05-03: Universe pivoted from BSC mid-caps to Binance-Peg majors.
// Mid-caps (TWT/ID/LISTA/ANKR) were too flat at 1-min granularity (ATR 0.01-0.04%/min)
// to ever hit a meaningful TP, and 3 of 5 had depth=false on PCS V2 anyway.
// Wrapped majors trade in deep PCS V2 pools, mirror their CEX prices via arb,
// and actually move 0.05-0.15% per minute — momentum has something to grab.
// CAKE retained as the one BSC-native datapoint with a working V2 pool.
// 2026-05-27 backtest-driven token selection. Tokens marked enabled:false
// were tested and dropped — they're documented here so we don't re-add
// them by accident.
//   CAKE: 5-token 180d -€7 worse than 4-token; flat-to-slightly-negative
//   LINK: 90d -€10 / 180d losses; momentum doesn't work
//   XRP : 0% win rate over 90d (-€15); different correlation profile, doesn't fit
//         the breakout-momentum pattern at all
const ALL_TOKENS = [
    {
        symbol: 'CAKE',
        enabled: false,  // dropped: ~0% win rate over 90d, marginally negative 180d
        address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
        decimals: 18,
        minLiquidityUsd: 5_000_000,
        allowlisted: true,
        binanceSymbol: 'CAKEUSDT'
    },
    {
        // Binance-Peg Ethereum Token — deep ETH/USDT V2 pool, mirrors ETHUSDT
        symbol: 'ETH',
        address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
        decimals: 18,
        minLiquidityUsd: 10_000_000,
        allowlisted: true,
        binanceSymbol: 'ETHUSDT'
    },
    {
        // Binance-Peg BTC Token (BTCB) — the canonical wrapped BTC on BSC
        symbol: 'BTCB',
        address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
        decimals: 18,
        minLiquidityUsd: 10_000_000,
        allowlisted: true,
        binanceSymbol: 'BTCUSDT'
    },
    {
        // Binance-Peg Solana — wrapped SOL on BSC
        symbol: 'SOL',
        address: '0x570A5D26f7765Ecb712C0924E4De545B89fD43dF',
        decimals: 18,
        minLiquidityUsd: 5_000_000,
        allowlisted: true,
        binanceSymbol: 'SOLUSDT'
    },
    // 2026-05-27: Added LINK, AVAX, XRP (option D from backtest review).
    // All Binance-Peg, live on PCS V3, large-cap with active 4h ATR.
    // Adds tokens with different correlation profiles than ETH/BTC/SOL —
    // LINK/AVAX track alts more than majors; XRP often moves independently.
    {
        symbol: 'LINK',
        enabled: false,  // dropped: 25% win rate, -€10 over 90d
        address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD',
        decimals: 18,
        minLiquidityUsd: 2_000_000,
        allowlisted: true,
        binanceSymbol: 'LINKUSDT'
    },
    {
        symbol: 'AVAX',
        address: '0x1CE0c2827e2eF14D5C4f29a091d735A204794041',
        decimals: 18,
        minLiquidityUsd: 2_000_000,
        allowlisted: true,
        binanceSymbol: 'AVAXUSDT'
    },
    {
        symbol: 'XRP',
        enabled: false,  // dropped: 0% win rate over 90d (-€15); doesn't fit momentum pattern
        address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE',
        decimals: 18,
        minLiquidityUsd: 2_000_000,
        allowlisted: true,
        binanceSymbol: 'XRPUSDT'
    }
];

// Active universe — strategies iterate over TOKENS. Disabled entries are
// kept in ALL_TOKENS for reference and easy re-enable.
const TOKENS = ALL_TOKENS.filter(t => t.enabled !== false);

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
