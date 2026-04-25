require('dotenv').config();

module.exports = {
    // --- Network / wallet ---
    RPC_URL: process.env.RPC_URL || 'https://bsc-dataseed.binance.org/',
    PRIVATE_KEY: process.env.PRIVATE_KEY,

    // PancakeSwap V2
    ROUTER_ADDRESS: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    FACTORY_ADDRESS: '0xcA143Ce32Fe78f1f7019d7d551a607b003182036',

    TOKENS: {
        WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
        BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        USDT: '0x55d398326f99059fF775485246999027B3197955'
    },

    // --- Mode ---
    // Live from day one — but can flip to true for dev work without touching real funds.
    SIMULATION_MODE: process.env.SIMULATION_MODE === 'true',

    // Kill switch — flip to 'true' in env and restart to halt new entries without code change.
    STOP_BOT: process.env.STOP_BOT === 'true',

    // --- Copy trader (now managed by copyTraderV2, kept for back-compat reads) ---
    COPY_MODE: process.env.COPY_MODE === 'true',
    TARGET_WALLETS: process.env.TARGET_WALLETS
        ? process.env.TARGET_WALLETS.split(',').filter(w => w.length > 0)
        : [
            '0xB828DBa1250956123599F7753080202b2114C15F',
            '0x4D87e3993cbDd65ee899DA3a77Fd0e3C043471b8',
            '0x6B582301c5dcF172B529D9e1F113a2742ab68F99'
        ],

    // --- Main loop cadence ---
    TICK_INTERVAL_MS: 5000,

    // --- THE single unified threshold block ---
    SIGNAL: {
        MIN_SCORE: 70,                    // 0-100; single gate for execution
        MIN_EDGE_PCT_AFTER_COSTS: 1.5,    // expected net edge to bother trading at €100 scale
        DECISION_TTL_SECONDS: 15,         // stale-decision invalidation
        TARGET_EDGE_PCT: 5.0              // used in edge_score normalization
    },

    // --- Risk (aggressive, calibrated for €100 live bankroll) ---
    RISK: {
        BASE_RISK_PCT: 20,                // 20% of cash as base bet, scaled by score
        MAX_POSITION_EUR: 25,
        MIN_POSITION_EUR: 18,
        MAX_CONCURRENT_POSITIONS: 3,
        MAX_EXPOSURE_PCT: 75,
        MAX_SINGLE_TOKEN_EXPOSURE_PCT: 25,
        MIN_CASH_RESERVE_EUR: 20,
        MIN_BNB_GAS_RESERVE: 0.01,        // ~€6 in BNB at $600
        MAX_DAILY_LOSS_PCT: 8,            // circuit breaker
        COOLDOWN_AFTER_LOSS_SECONDS: 300,
        // Phase 3 shadow-live cap: temporarily override MAX_POSITION_EUR to €5 via env.
        SHADOW_LIVE_CAP_EUR: process.env.SHADOW_LIVE_CAP_EUR
            ? parseFloat(process.env.SHADOW_LIVE_CAP_EUR)
            : null
    },

    EXITS: {
        STOP_LOSS_PCT: 5,
        TAKE_PROFIT_PCT: 10,
        TRAIL_ATR_MULTIPLE: 1.5,
        MAX_HOLD_MINUTES: 240
    },

    COSTS: {
        GAS_PER_TX_USD: 0.80,             // realistic BSC swap gas in 2026
        SWAP_FEE_PCT: 0.25,               // PCS V2 LP fee
        SLIPPAGE_BUFFER_PCT: 1.0,         // tightened for live mode
        LIVE_SLIPPAGE_TOLERANCE_PCT: 1.0  // amountOutMin = quote * (100 - this) / 100
    },

    STRATEGIES: {
        MOMENTUM: { enabled: true, weight: 1.0 },
        COPY: { enabled: process.env.COPY_MODE === 'true', weight: 0.6 },
        CROSS_DEX_ARB: { enabled: false, weight: 0.7 } // deferred until bankroll > €300
    }
};
