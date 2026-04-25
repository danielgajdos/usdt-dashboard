// Smoke test: verify signalEngine scoring + gate logic.
// Run: node scripts/testSignalEngine.js

const signalEngine = require('../signalEngine');
const config = require('../config');

let failures = 0;
function assert(cond, msg) {
    if (!cond) {
        console.error(`  FAIL: ${msg}`);
        failures++;
    } else {
        console.log(`  ok   ${msg}`);
    }
}

console.log('--- signalEngine.scoreDecision ---');
{
    const low = signalEngine.scoreDecision(0.1, 0.1);
    const high = signalEngine.scoreDecision(5.0, 1.0);
    assert(high > low, 'high edge + high confidence > low+low');
    assert(low >= 0 && low <= 100, 'score bounded 0-100');
    assert(high >= 0 && high <= 100, 'score bounded 0-100');
}

console.log('--- emptyDecision defaults ---');
{
    const d = signalEngine.emptyDecision();
    assert(d.action === 'SKIP', 'default action SKIP');
    assert(d.score === 0, 'default score 0');
    assert(d.ttlSeconds === config.SIGNAL.DECISION_TTL_SECONDS, 'ttl from config');
}

console.log('--- passesGate ---');
{
    // Below MIN_SCORE
    const weak = signalEngine.emptyDecision({
        action: 'ENTER',
        score: config.SIGNAL.MIN_SCORE - 5,
        expectedEdgePct: 5
    });
    assert(!signalEngine.passesGate(weak, null).ok, 'low score rejected');

    // Below MIN_EDGE
    const lowEdge = signalEngine.emptyDecision({
        action: 'ENTER',
        score: config.SIGNAL.MIN_SCORE + 10,
        expectedEdgePct: 0.5
    });
    assert(!signalEngine.passesGate(lowEdge, null).ok, 'low edge rejected');

    // Passes
    const good = signalEngine.emptyDecision({
        action: 'ENTER',
        score: config.SIGNAL.MIN_SCORE + 10,
        expectedEdgePct: config.SIGNAL.MIN_EDGE_PCT_AFTER_COSTS + 1
    });
    const gate = signalEngine.passesGate(good, null);
    assert(gate.ok, `good decision passes (${gate.reason || ''})`);

    // Stale
    const stale = signalEngine.emptyDecision({
        action: 'ENTER',
        score: 90,
        expectedEdgePct: 5,
        ttlSeconds: 10,
        timestamp: Date.now() - 30000
    });
    assert(!signalEngine.passesGate(stale, null).ok, 'stale decision rejected');
}

console.log('--- register/scan ---');
{
    signalEngine.reset();

    const fake = {
        name: 'MOMENTUM',
        evaluate: async () => [
            signalEngine.emptyDecision({
                action: 'ENTER',
                score: 80,
                expectedEdgePct: 3,
                strategy: 'MOMENTUM',
                token: '0x1111111111111111111111111111111111111111',
                symbol: 'TEST'
            })
        ]
    };
    signalEngine.register(fake);

    (async () => {
        const decisions = await signalEngine.scan({});
        assert(decisions.length === 1, `scan returns 1 decision (got ${decisions.length})`);
        assert(decisions[0].score > 0, 'decision has score');

        console.log('\n' + (failures === 0 ? '✓ all tests passed' : `✗ ${failures} failure(s)`));
        process.exit(failures === 0 ? 0 : 1);
    })();
}
