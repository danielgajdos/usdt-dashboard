// News-driven strategy — STUB. Will consume signals from /signals/newsLLM.js
// once that service is built. Until then this returns no decisions, keeping
// the bot bootable while the LLM layer is under construction.

const NAME = 'NEWS_DRIVEN';

async function evaluate(/* ctx */) {
    return [];
}

module.exports = { name: NAME, evaluate };
