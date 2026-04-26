// News-driven LLM signal service.
//
// Architecture:
//   1. Every NEWS.POLL_INTERVAL_MS, fetch the N freshest crypto headlines from
//      CryptoCompare's free news endpoint (no API key required for basic access).
//   2. Batch all headlines into ONE Claude Haiku call that returns a JSON array of
//      { symbol, direction, confidence, magnitudePct, reason } objects.
//   3. Cache signals keyed by symbol with a TTL. The strategy reads the cache.
//
// Budget: one Haiku call per 3-min poll, ~100-150 input tokens + 60-80 output tokens.
// At $0.25/M input + $1.25/M output that's ~$0.05/day — negligible.

'use strict';

const https = require('https');
const config = require('../config');
const { TOKENS } = require('../tokens');

// ---- Signal cache --------------------------------------------------------
// Map<symbolUpper, { direction, confidence, magnitudePct, reason, expiresAt }>
const signalCache = new Map();

function cacheSignal(sym, signal) {
    signalCache.set(sym.toUpperCase(), {
        ...signal,
        expiresAt: Date.now() + config.NEWS.SIGNAL_TTL_SECONDS * 1000
    });
}

function getSignal(sym) {
    const s = signalCache.get(sym.toUpperCase());
    if (!s) return null;
    if (Date.now() > s.expiresAt) { signalCache.delete(sym.toUpperCase()); return null; }
    return s;
}

// ---- CryptoCompare news ---------------------------------------------------
// Free endpoint — no key required, returns latest crypto news articles.
function fetchHeadlines() {
    return new Promise((resolve, reject) => {
        const url = 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&sortOrder=latest';
        https.get(url, { timeout: 8000 }, res => {
            let raw = '';
            res.on('data', d => raw += d);
            res.on('end', () => {
                try {
                    const body = JSON.parse(raw);
                    if (body.Type !== 100 || !Array.isArray(body.Data)) {
                        return resolve([]);
                    }
                    resolve(body.Data.slice(0, config.NEWS.MAX_HEADLINES_PER_POLL));
                } catch { resolve([]); }
            });
        }).on('error', reject).on('timeout', () => reject(new Error('news fetch timeout')));
    });
}

// ---- Anthropic call -------------------------------------------------------
// We import @anthropic-ai/sdk lazily to avoid crashing the bot when the env
// var is absent (newsDriven strategy is simply disabled in that case).
let _anthropic = null;
function getAnthropic() {
    if (!_anthropic) {
        const { Anthropic } = require('@anthropic-ai/sdk');
        _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return _anthropic;
}

// Token symbols the LLM should watch for. Computed once.
const WATCHED_SYMBOLS = TOKENS.map(t => t.symbol);

async function analyseWithLLM(headlines) {
    if (!headlines.length) return [];

    const headlineText = headlines
        .map((h, i) => `${i + 1}. [${new Date(h.published_on * 1000).toISOString().slice(0, 16)}] ${h.title}`)
        .join('\n');

    const systemPrompt =
        'You are a crypto trading signal extractor. ' +
        'Respond ONLY with a valid JSON array, no prose, no markdown fences.';

    const userPrompt =
        `Token universe: ${WATCHED_SYMBOLS.join(', ')}\n\n` +
        `Headlines:\n${headlineText}\n\n` +
        'For each headline that mentions one of the listed tokens and suggests a price move ' +
        'within the next 30 minutes, output ONE object:\n' +
        '{"symbol":"CAKE","direction":"UP","confidence":75,"magnitudePct":4,"reason":"one sentence"}\n' +
        'Rules:\n' +
        '- direction: "UP" or "DOWN"\n' +
        '- confidence: 0-100 (your conviction)\n' +
        '- magnitudePct: expected % move (1-20)\n' +
        '- Only include tokens where confidence >= 60 and magnitudePct >= 2\n' +
        '- If nothing qualifies, return []\n' +
        'Return ONLY the JSON array.';

    const response = await getAnthropic().messages.create({
        model: config.NEWS.ANTHROPIC_MODEL,
        max_tokens: config.NEWS.MAX_TOKENS_PER_CALL,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
    });

    const text = response.content[0]?.text?.trim() || '[]';
    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) return [];
        // Validate each item
        return parsed.filter(s =>
            typeof s.symbol === 'string' &&
            (s.direction === 'UP' || s.direction === 'DOWN') &&
            typeof s.confidence === 'number' &&
            typeof s.magnitudePct === 'number' &&
            s.confidence >= config.NEWS.MIN_LLM_CONFIDENCE &&
            s.magnitudePct >= config.NEWS.MIN_LLM_MAGNITUDE_PCT &&
            WATCHED_SYMBOLS.includes(s.symbol.toUpperCase())
        );
    } catch {
        return [];
    }
}

// ---- Poll loop -----------------------------------------------------------
let _pollTimer = null;

async function poll(log) {
    if (!process.env.ANTHROPIC_API_KEY) return; // disabled without key
    if (config.STOP_BOT) return;

    try {
        const headlines = await fetchHeadlines();
        if (!headlines.length) return;

        const signals = await analyseWithLLM(headlines);
        for (const s of signals) {
            cacheSignal(s.symbol, s);
            if (log) log(`[newsLLM] signal: ${s.symbol} ${s.direction} conf=${s.confidence} mag=${s.magnitudePct}% — ${s.reason}`);
        }
        if (log && !signals.length) {
            log('[newsLLM] poll: no qualifying signals in latest headlines');
        }
    } catch (err) {
        if (log) log(`[newsLLM] poll error: ${err.message}`);
    }
}

function start(log) {
    if (!process.env.ANTHROPIC_API_KEY) {
        if (log) log('[newsLLM] ANTHROPIC_API_KEY not set — news layer disabled');
        return;
    }
    // First poll immediately, then repeat
    poll(log);
    _pollTimer = setInterval(() => poll(log), config.NEWS.POLL_INTERVAL_MS);
    if (log) log(`[newsLLM] started — polling every ${config.NEWS.POLL_INTERVAL_MS / 1000}s, model=${config.NEWS.ANTHROPIC_MODEL}`);
}

function stop() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

module.exports = { start, stop, getSignal, poll };
