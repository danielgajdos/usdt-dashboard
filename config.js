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
        MIN_SCORE: 28,                    // 0-100; aggressive — math forces edgeScore≈0 at €25, so score=60×conf max. Need MIN low enough that high-conf signals pass during all sessions, including dead zone.
        // 2026-05-07: With €150 sizing + V3 routing, friction is ~0.97%, so most
        // signals can achieve marginal positive edge. But MR/RANGE on majors with
        // tight bands often produce edge in [-1.0%, +0.3%]. Allowing slight
        // negative edge through the unified gate trusts the early-exit logic to
        // cap realized losses below the static math.
        MIN_EDGE_PCT_AFTER_COSTS: -1.0,
        DECISION_TTL_SECONDS: 15,         // stale-decision invalidation
        TARGET_EDGE_PCT: 1.0              // achievable target after the TP cut
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
        COOLDOWN_AFTER_LOSS_SECONDS: 1800,    // 30 min — protect against re-entering same token in chop
        // Phase 3 shadow-live cap: temporarily override MAX_POSITION_EUR to €5 via env.
        SHADOW_LIVE_CAP_EUR: process.env.SHADOW_LIVE_CAP_EUR
            ? parseFloat(process.env.SHADOW_LIVE_CAP_EUR)
            : null
    },

    EXITS: {
        // Recalibrated for actual BSC mid-cap volatility (ATR ≈ 0.01-0.05%/min).
        // Old 13% TP was unreachable inside MAX_HOLD; ALL 12 trades since
        // 2026-04-29 timed out at 240min with -2 to -3% drift losses.
        // New TP=4% is reachable in 30-60min during active sessions; SL=2.5%
        // covers round-trip cost (~2.3%) with small margin.
        STOP_LOSS_PCT: 2.5,
        TAKE_PROFIT_PCT: 4.0,
        TRAIL_ATR_MULTIPLE: 1.0,          // tighter trail after TP1
        MAX_HOLD_MINUTES: 60,             // faster cycling: 4h → 1h
        // Early-exit thresholds (used by riskManager.shouldExit alongside SL/TP/timeout)
        MOMENTUM_DEATH_MIN_AGE_MIN: 5,    // grace period after entry before checking EMA reversion
        OVERHEATED_RSI: 75,               // exit profitable position when RSI tags this
        STUCK_LOSS_AGE_MIN: 15            // exit losing positions early if signal dead
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
        // RANGE: chop strategy — fires when price is near 15-min low in a defined
        // band with no trend. Complementary to MOMENTUM (which needs uptrend) and
        // MEAN_REVERSION (which needs RSI oversold). Marginal-EV by design at €25;
        // early-exit logic is what makes it net positive.
        RANGE: { enabled: true, weight: 0.85 },
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
