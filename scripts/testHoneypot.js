// Live honeypot check against known tokens.
// Run: node scripts/testHoneypot.js
//
// MUST pass before enabling live mode with non-allowlisted tokens.

const { ethers } = require('ethers');
const config = require('../config');
const honeypot = require('../safety/honeypot');

// Known legit BSC tokens — should PASS
const LEGIT = [
    { symbol: 'CAKE', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' },
    { symbol: 'XVS', address: '0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63' },
    { symbol: 'BSW', address: '0x965F527D9159dCe6288a2219DB51fc6Eef120dD1' },
    { symbol: 'ALPACA', address: '0x8F0528cE5eF7B51152A59745bEfDD91D97091d2F' },
    { symbol: 'ANKR', address: '0xf307910A4c7bbc79691fD374889b36d8531B08e3' }
];

// Known/suspected honeypots — should FAIL.
// NOTE: replace these with specific addresses flagged on honeypot.is / BscScan before running the full gate.
// If unsure, leave this empty and test legit-only; the gate still requires passing the sim-sell before any non-allowlisted buy.
const HONEYPOTS = [
    // Example: { symbol: 'SQUID', address: '0x87230146E138d3F296a9a77e497A2A83012e9Bc5' }
];

async function main() {
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);

    console.log('--- LEGIT tokens (expect pass) ---');
    let legitPass = 0;
    for (const t of LEGIT) {
        try {
            const r = await honeypot.check(provider, t.address);
            const ok = r.passed;
            if (ok) legitPass++;
            console.log(`  ${ok ? '✓' : '✗'} ${t.symbol}: ${ok ? 'pass' : 'FAIL'} (score ${r.score})${r.details.reason ? ' — ' + r.details.reason : ''}`);
        } catch (err) {
            console.log(`  ✗ ${t.symbol}: ERROR ${err.message}`);
        }
    }

    console.log('\n--- HONEYPOT tokens (expect reject) ---');
    let hpReject = 0;
    for (const t of HONEYPOTS) {
        try {
            const r = await honeypot.check(provider, t.address);
            const ok = !r.passed;
            if (ok) hpReject++;
            console.log(`  ${ok ? '✓' : '✗'} ${t.symbol}: ${ok ? 'rejected' : 'FAIL (incorrectly passed)'} (score ${r.score})${r.details.reason ? ' — ' + r.details.reason : ''}`);
        } catch (err) {
            console.log(`  ✓ ${t.symbol}: rejected by exception (${err.message})`);
            hpReject++;
        }
    }

    const totalLegit = LEGIT.length;
    const totalHp = HONEYPOTS.length;
    console.log(`\nSummary: ${legitPass}/${totalLegit} legit pass, ${hpReject}/${totalHp} honeypot reject`);

    const failLegit = legitPass < totalLegit;
    const failHp = totalHp > 0 && hpReject < totalHp;
    process.exit(failLegit || failHp ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(2);
});
