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
        // 2026-05-08: TIMEFRAME PIVOT to 4-hour bars.
        // Klines fetched at interval=4h. EMAs/RSI/ATR all on 4h candles.
        // Targets ~10x larger relative to friction → static math is genuinely positive.
        // Tighter gate now that signals are higher-quality (multi-day swings, not 1-min noise).
        MIN_SCORE: 50,
        MIN_EDGE_PCT_AFTER_COSTS: 1.0,    // require real positive expected edge
        DECISION_TTL_SECONDS: 60,         // 4h regime — give signals more time before staling
        TARGET_EDGE_PCT: 4.0              // typical achievable edge on 4h swings
    },

    // --- Risk (aggressive, calibrated for €100 live bankroll) ---
    RISK: {
        BASE_RISK_PCT: 20,                // 20% of cash as base bet, scaled by score
        // 2026-05-07: bankroll scaled to $600. Position size bumped to €150 to
        // dilute the $0.20 round-trip gas (was 2.3% of trade at €25, now 0.27%).
        // Math at TP=4%/SL=2.5% goes from break-even at 47% win-rate to 36%.
        MAX_POSITION_EUR: 150,
        MIN_POSITION_EUR: 50,             // no point trading €25 at €600 bankroll
        MAX_CONCURRENT_POSITIONS: 3,
        MAX_EXPOSURE_PCT: 75,             // 3 × €150 = €450 deployed max, €150 reserve
        MAX_SINGLE_TOKEN_EXPOSURE_PCT: 25, // €150 single-token cap = exactly MAX_POSITION
        MIN_CASH_RESERVE_EUR: 100,        // proportional reserve floor
        MIN_BNB_GAS_RESERVE: 0.01,        // ~€6 in BNB at $600
        MAX_DAILY_LOSS_PCT: 8,            // circuit breaker
        COOLDOWN_AFTER_LOSS_SECONDS: 86400,   // 24h — at 4h timeframe, don't re-trade the same setup the same day
        // Phase 3 shadow-live cap: temporarily override MAX_POSITION_EUR to €5 via env.
        SHADOW_LIVE_CAP_EUR: process.env.SHADOW_LIVE_CAP_EUR
            ? parseFloat(process.env.SHADOW_LIVE_CAP_EUR)
            : null
    },

    EXITS: {
        // 2026-05-08: 4h-timeframe pivot. ETH 4h ATR ≈ 1.5-3%, BTC ≈ 1-2%, SOL ≈ 2-4%.
        // Targets/stops scaled to multi-day swing magnitudes:
        //   - Hitting +10% TP in 3 days = ~3-5 ATR move (achievable on real trends)
        //   - Hitting -5% SL in 3 days = ~2-3 ATR move (early exits cap most losses well before)
        //   - 0.97% friction is now <10% of TP (was 24% at TP=4%)
        STOP_LOSS_PCT: 5.0,
        TAKE_PROFIT_PCT: 10.0,
        TRAIL_ATR_MULTIPLE: 1.5,
        MAX_HOLD_MINUTES: 4320,           // 72h = 3 days
        // Grace periods adapted to 4h bars (1 bar = 240 min):
        MOMENTUM_DEATH_MIN_AGE_MIN: 240,  // 4h grace — wait one full bar before checking EMA reversion
        OVERHEATED_RSI: 75,               // RSI is timeframe-agnostic, threshold unchanged
        STUCK_LOSS_AGE_MIN: 720           // 12h grace — three bars before cutting stuck losers
    },

    COSTS: {
        // BSC mainnet gas in 2026: ~3-4 gwei × ~130k gas × BNB@$600 ≈ $0.18-$0.24.
        // Old $0.35 estimate inflated cost model and made every probWin look hopeless.
        GAS_PER_TX_USD: 0.20,
        SWAP_FEE_PCT: 0.25,               // PCS V2 LP fee per leg
        EXPECTED_SLIPPAGE_PCT: 0.10,      // expected slippage for deep-pool tokens at €25 (used in edge calc)
        SLIPPAGE_BUFFER_PCT: 1.0,         // max-slippage tolerance for tx (amountOutMin guard)
        LIVE_SLIPPAGE_TOLERANCE_PCT: 1.0  // amountOutMin = quote * (100 - this) / 100
    },

    STRATEGIES: {
        MOMENTUM: { enabled: true, weight: 1.0 },
        MEAN_REVERSION: { enabled: true, weight: 0.9 },
        // RANGE: disabled at 4h timeframe — its 15-bar lookback (= 60h band) and
        // tight 1.2% stop don't translate to swing trading. Re-enable only with
        // a 4h-specific reimplementation (multi-day support/resistance bands).
        RANGE: { enabled: false, weight: 0.85 },
        NEWS_DRIVEN: { enabled: process.env.ANTHROPIC_API_KEY ? true : false, weight: 1.1 },
        STABLE_ARB: { enabled: true, weight: 0.8 },
        COPY: { enabled: process.env.COPY_MODE === 'true', weight: 0.6 },
        CROSS_DEX_ARB: { enabled: false, weight: 0.7 } // deferred until bankroll > €300
    },

    // News-driven LLM strategy config
    NEWS: {
        POLL_INTERVAL_MS: 3 * 60 * 1000,           // poll every 3 min
        MAX_HEADLINES_PER_POLL: 8,                  // top N freshest crypto headlines
        SIGNAL_TTL_SECONDS: 30 * 60,                // a news signal stays valid 30 min
        MIN_LLM_CONFIDENCE: 70,                     // 0-100, from Claude analysis
        MIN_LLM_MAGNITUDE_PCT: 3,                   // need >3% predicted move
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
        MAX_TOKENS_PER_CALL: 200,                   // tight cap — JSON output only
        ENABLED_AT_LIVE: true                       // disable when STOP_BOT or budget hit
    },

    // Stablecoin depeg arb config
    STABLE_ARB: {
        STABLES: [
            { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
            { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
            { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
            { symbol: 'FDUSD', address: '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', decimals: 18 },
            { symbol: 'DAI',  address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', decimals: 18 }
        ],
        QUOTE_NOTIONAL_USD: 25,                    // size of each arb attempt
        MIN_NET_EDGE_PCT: 0.20,                    // need 0.2% NET (after fees+gas+slippage)
        MIN_DEPEG_PCT: 1.5,                        // min depeg % to trigger signal
        MAX_DEPEG_PCT: 8.0,                        // above this → likely permanent depeg, skip
        MAX_NOTIONAL_PER_ATTEMPT: 50,              // hard cap per attempt
        STALE_QUOTE_MS: 4000                        // quote must be < 4s old when executing
    }
};
