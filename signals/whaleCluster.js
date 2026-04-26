// Whale cluster detector.
//
// Every 30 s (6 BSC blocks) we call getLogs on the PancakeSwap V2 factory to
// fetch Swap events across all tracked token pairs.  Swaps above WHALE_USD_THRESHOLD
// are classified as whale buys or sells.  A rolling 5-minute pressure score is
// maintained per token and exposed as getWhaleSignal(address).
//
// Design choices:
//   - One getLogs call per poll (all pairs in one filter) instead of N per token.
//   - WBNB-denominated amounts are converted to USD using the cached WBNB price.
//   - Pressure decays linearly to 0 over SIGNAL_TTL_SECONDS so stale signals vanish.
//   - If getLogs is unavailable (HTTP RPC, no eth_getLogs support), we fall back
//     silently — whaleSignal returns null and strategies treat it as neutral.

'use strict';

const { ethers } = require('ethers');
const { TOKENS } = require('../tokens');

// PCS V2 factory for getPair queries
const FACTORY_ADDRESS = '0xcA143Ce32Fe78f1f7019d7d551a607b003182036';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

const FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) external view returns (address pair)'
];

// Minimal ABI for Swap event
const PAIR_ABI = [
    'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)'
];

// --- Config defaults (can be overridden via config if needed) ---
const WHALE_USD_THRESHOLD = 5_000;   // swaps > $5k qualify as whale activity
const SIGNAL_TTL_MS = 5 * 60 * 1000; // 5-minute rolling window
const BLOCKS_PER_POLL = 6;            // look back 6 blocks each poll (~30s on BSC)

// --- State ---
// Map<tokenAddressLower, { netPressureUsd, updatedAt }>
const pressureMap = new Map();

// Map<tokenAddressLower, pairAddress>  (cached — pairs don't change)
const pairCache = new Map();

// Approximate WBNB price in USD (updated from marketData when available)
let wbnbPriceUsd = 600; // safe default

// Pair interface for log decoding
const pairInterface = new ethers.Interface(PAIR_ABI);

// ---- Pair discovery --------------------------------------------------
async function getPairAddress(provider, tokenAddress) {
    const key = tokenAddress.toLowerCase();
    if (pairCache.has(key)) return pairCache.get(key);
    try {
        const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
        const pair = await factory.getPair(tokenAddress, WBNB);
        if (!pair || pair === ethers.ZeroAddress) {
            pairCache.set(key, null);
            return null;
        }
        pairCache.set(key, pair.toLowerCase());
        return pair.toLowerCase();
    } catch { return null; }
}

// ---- Swap event parsing ----------------------------------------------
// For a WBNB/token pair: token0 < token1 lexicographically.
// If WBNB is token0: amount0In>0 → WBNB in (whale buy), amount0Out>0 → WBNB out (whale sell).
// If WBNB is token1: amount1In>0 → WBNB in, amount1Out>0 → WBNB out.
function parseSwap(log, wbnbIsToken0) {
    try {
        const parsed = pairInterface.parseLog({ topics: log.topics, data: log.data });
        const { amount0In, amount1In, amount0Out, amount1Out } = parsed.args;
        let wbnbIn, wbnbOut;
        if (wbnbIsToken0) {
            wbnbIn  = parseFloat(ethers.formatEther(amount0In));
            wbnbOut = parseFloat(ethers.formatEther(amount0Out));
        } else {
            wbnbIn  = parseFloat(ethers.formatEther(amount1In));
            wbnbOut = parseFloat(ethers.formatEther(amount1Out));
        }
        const buyUsd  = wbnbIn  * wbnbPriceUsd; // WBNB flows IN → someone buys the token
        const sellUsd = wbnbOut * wbnbPriceUsd; // WBNB flows OUT → someone sells the token
        return { buyUsd, sellUsd };
    } catch { return null; }
}

// ---- Pressure update -------------------------------------------------
function applyPressure(tokenAddress, netUsd) {
    const key = tokenAddress.toLowerCase();
    const existing = pressureMap.get(key) || { netPressureUsd: 0, updatedAt: Date.now() };
    // Decay old pressure proportionally (linear decay to 0 over TTL)
    const age = Date.now() - existing.updatedAt;
    const decayFactor = Math.max(0, 1 - age / SIGNAL_TTL_MS);
    const decayed = existing.netPressureUsd * decayFactor;
    pressureMap.set(key, {
        netPressureUsd: decayed + netUsd,
        updatedAt: Date.now()
    });
}

// ---- Main poll -------------------------------------------------------
async function poll(provider) {
    try {
        // Update WBNB price from any token's indirect price if possible
        // (we use 600 as default; in production the tick loop has refreshed prices)
        const { getLastPrice } = require('../marketData');
        const wbnbRaw = getLastPrice(WBNB);
        if (wbnbRaw && wbnbRaw > 0) wbnbPriceUsd = wbnbRaw;

        const latestBlock = await provider.getBlockNumber();
        const fromBlock = latestBlock - BLOCKS_PER_POLL;

        // Ensure all pairs are discovered
        const pairAddresses = [];
        const pairToToken = new Map();
        for (const token of TOKENS) {
            const pairAddr = await getPairAddress(provider, token.address);
            if (!pairAddr) continue;
            pairAddresses.push(pairAddr);
            pairToToken.set(pairAddr, token);
        }
        if (!pairAddresses.length) return;

        // Single getLogs call for all pairs
        const swapTopic = pairInterface.getEvent('Swap').topicHash;
        const logs = await provider.getLogs({
            fromBlock,
            toBlock: latestBlock,
            address: pairAddresses,
            topics: [swapTopic]
        });

        // Process each log
        for (const log of logs) {
            const pairAddr = log.address.toLowerCase();
            const token = pairToToken.get(pairAddr);
            if (!token) continue;

            // Determine WBNB token order in this pair (needed for amount parsing)
            const wbnbIsToken0 = WBNB.toLowerCase() < token.address.toLowerCase();
            const swap = parseSwap(log, wbnbIsToken0);
            if (!swap) continue;

            // Net = buy pressure minus sell pressure for this single swap
            const netUsd = swap.buyUsd - swap.sellUsd;
            const magnitude = Math.max(swap.buyUsd, swap.sellUsd);
            if (magnitude < WHALE_USD_THRESHOLD) continue; // ignore retail noise

            applyPressure(token.address, netUsd);
        }
    } catch {
        // getLogs can fail on some public RPCs — silent fallback, strategies use neutral
    }
}

// ---- Public API ------------------------------------------------------

/**
 * Returns the current whale pressure signal for a token, or null if unknown.
 * {
 *   netPressureUsd: number,   // positive = net buy pressure, negative = net sell
 *   direction: 'BUY'|'SELL'|'NEUTRAL',
 *   strengthScore: number     // 0-1, how strong relative to threshold
 * }
 */
function getWhaleSignal(tokenAddress) {
    const key = tokenAddress.toLowerCase();
    const s = pressureMap.get(key);
    if (!s) return null;

    // Apply decay before returning
    const age = Date.now() - s.updatedAt;
    const decayFactor = Math.max(0, 1 - age / SIGNAL_TTL_MS);
    const net = s.netPressureUsd * decayFactor;

    if (Math.abs(net) < WHALE_USD_THRESHOLD * 0.5) {
        return { netPressureUsd: net, direction: 'NEUTRAL', strengthScore: 0 };
    }

    const direction = net > 0 ? 'BUY' : 'SELL';
    // strengthScore: 1.0 at 5× threshold, 0 at threshold
    const strengthScore = Math.min(1, Math.abs(net) / (WHALE_USD_THRESHOLD * 5));
    return { netPressureUsd: net, direction, strengthScore };
}

/** Call this from the tick loop every 30s (checks % 6 === 0). */
async function update(provider) {
    return poll(provider);
}

module.exports = { update, getWhaleSignal, WHALE_USD_THRESHOLD };
