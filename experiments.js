#!/usr/bin/env node
// Backtest experiment runner — fires off multiple backtest configurations
// in parallel and produces a comparison table.
//
//   node experiments.js                    # run the default battery
//   node experiments.js --days 180          # over a longer window
//   node experiments.js --skip-eth          # exclude ETH from experiments
//
// Each experiment is a name + env overrides; we spawn `node backtest.js` as
// a child process so each gets a fresh config load.  Results parsed from
// the AGGREGATE summary line.

const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const argv = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i+1] : d; };
const DAYS = argv('days', '90');
const SKIP_ETH = args.includes('--skip-eth');
const VERBOSE = args.includes('--verbose');

// Experiment definitions: each row = { name, env_overrides, extraArgs? }
// Baseline first, then single-variable variants, then combined winners.
const EXPERIMENTS = [
    // -- BASELINE ---------------------------------------------------------
    { name: 'baseline (current live)',
      env: {} },

    // -- TOKEN UNIVERSE --------------------------------------------------
    { name: 'skip ETH (worst performer)',
      env: {}, args: ['--token', 'BTCB'] },   // we'll override below to run per-token

    // -- HOT-RSI GATE (the headline fix) ---------------------------------
    { name: 'hot-RSI ≤ 60 (strict — only fresh breakouts)',
      env: { BT_MOM_MAX_RSI: '60' } },
    { name: 'hot-RSI ≤ 55 (very strict)',
      env: { BT_MOM_MAX_RSI: '55' } },

    // -- TP / SL VARIANTS ------------------------------------------------
    { name: 'TP=6%  (smaller TP, higher hit rate)',
      env: { BT_TP: '6' } },
    { name: 'TP=8%  (intermediate)',
      env: { BT_TP: '8' } },
    { name: 'TP=15% (further out, trend-rider mode)',
      env: { BT_TP: '15' } },

    { name: 'SL=3%  (tighter — cut losers faster)',
      env: { BT_SL: '3' } },
    { name: 'SL=7%  (wider — survive noise)',
      env: { BT_SL: '7' } },

    // -- EXIT LOGIC TUNING -----------------------------------------------
    { name: 'stuck-grace 24h (let trades breathe)',
      env: { BT_STUCK_GRACE: '1440' } },
    { name: 'stuck-grace 48h (long give)',
      env: { BT_STUCK_GRACE: '2880' } },
    { name: 'overheated RSI=80 (let winners run)',
      env: { BT_OVERHEAT: '80' } },
    { name: 'overheated RSI=85 (let winners run more)',
      env: { BT_OVERHEAT: '85' } },

    // -- SCORE GATE ------------------------------------------------------
    { name: 'MIN_SCORE=60 (selective)',
      env: { BT_MIN_SCORE: '60' } },
    { name: 'MIN_SCORE=70 (very selective)',
      env: { BT_MIN_SCORE: '70' } },

    // -- COMBINED CANDIDATES (built from round-1 winners) ----------------
    { name: 'COMBO: hot-RSI≤55 + stuck-grace=48h (top-2 stacked)',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '2880' } },
    { name: 'COMBO: hot-RSI≤55 + stuck-grace=72h (push grace)',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '4320' } },
    { name: 'COMBO: hot-RSI≤55, all but ETH',
      env: { BT_MOM_MAX_RSI: '55' }, args: ['--skip', 'ETH'] },
    { name: 'COMBO: hot-RSI≤55 + stuck-grace=48h, all but ETH',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '2880' }, args: ['--skip', 'ETH'] },
    { name: 'COMBO: hot-RSI≤55 + grace=48h, only BTCB+CAKE',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '2880' }, args: ['--skip', 'ETH,SOL'] },
    { name: 'BASELINE all-but-ETH (no other changes)',
      env: {}, args: ['--skip', 'ETH'] },

    // -- ROUND 3: push the winner further ---------------------------------
    { name: 'WINNER+: hot-RSI≤50 + grace=72h (stricter entry)',
      env: { BT_MOM_MAX_RSI: '50', BT_STUCK_GRACE: '4320' } },
    { name: 'WINNER+: hot-RSI≤55 + grace=96h (longer grace)',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '5760' } },
    { name: 'WINNER+: hot-RSI≤55 + grace=72h + TP=8',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '4320', BT_TP: '8' } },
    { name: 'WINNER+: hot-RSI≤55 + grace=72h + TP=12',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '4320', BT_TP: '12' } },
    { name: 'WINNER+: hot-RSI≤55 + grace=72h + SL=6',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '4320', BT_SL: '6' } },
    { name: 'WINNER+: hot-RSI≤55 + grace=72h + SL=7',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '4320', BT_SL: '7' } },
    { name: 'WINNER+: hot-RSI≤55 + grace=72h + overheated=80',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '4320', BT_OVERHEAT: '80' } },
    { name: 'WINNER+: hot-RSI≤55 + grace=72h + max-hold=120h',
      env: { BT_MOM_MAX_RSI: '55', BT_STUCK_GRACE: '4320', BT_MAX_HOLD: '7200' } },

    // -- ROUND 4: 2026-05-27 — A+B+C+D additions ------------------------
    { name: 'R4: current+LINK+AVAX+XRP+deepDip+MR-loose',
      env: {} },
    { name: 'R4: skip XRP (worst new token)',
      env: {}, args: ['--skip', 'XRP'] },
    { name: 'R4: skip CAKE,LINK,XRP (keep only majors+AVAX+SOL)',
      env: {}, args: ['--skip', 'CAKE,LINK,XRP'] },
    { name: 'R4: only SOL+AVAX (the winners)',
      env: {}, args: ['--skip', 'CAKE,ETH,BTCB,LINK,XRP'] },
    { name: 'R4: skip XRP+LINK (drop net losers)',
      env: {}, args: ['--skip', 'XRP,LINK'] },
    { name: 'R4: skip XRP, MOMENTUM only (no MR, no DD)',
      env: {}, args: ['--skip', 'XRP', '--strategy', 'MOMENTUM'] },

    // -- ROUND 5: DEEP_DIP shown to be net negative — try without it ----
    { name: 'R5: SOL+AVAX, MOMENTUM+MR only (no DD)',
      env: {}, args: ['--skip', 'CAKE,ETH,BTCB,LINK,XRP', '--strategy', 'MOMENTUM,MEAN_REVERSION'] },
    { name: 'R5: skip CAKE,LINK,XRP, MOMENTUM+MR (no DD)',
      env: {}, args: ['--skip', 'CAKE,LINK,XRP', '--strategy', 'MOMENTUM,MEAN_REVERSION'] },
    { name: 'R5: skip XRP+LINK, MOMENTUM+MR (no DD)',
      env: {}, args: ['--skip', 'XRP,LINK', '--strategy', 'MOMENTUM,MEAN_REVERSION'] },
];

function runExperiment(exp) {
    const env = { ...process.env, ...exp.env };
    const extraArgs = exp.args || [];
    const subArgs = ['backtest.js', '--days', DAYS, '--no-sentiment', ...extraArgs];
    const result = spawnSync('node', subArgs, { env, encoding: 'utf8', cwd: __dirname });

    if (result.status !== 0) {
        return { name: exp.name, error: `exit ${result.status}: ${(result.stderr||'').slice(0,200)}` };
    }

    const out = result.stdout || '';
    if (VERBOSE) console.log(out);

    // Parse AGGREGATE summary (or single-token summary if --token used)
    let parsed = parseAggregate(out) || parseSingleToken(out);
    if (!parsed) return { name: exp.name, error: 'could not parse summary' };

    return { name: exp.name, env: exp.env, args: extraArgs, ...parsed };
}

function parseAggregate(out) {
    const m1 = out.match(/AGGREGATE[\s\S]*?Decisions generated:\s*(\d+),\s*executed:\s*(\d+)[\s\S]*?Total trades:\s*(\d+)[\s\S]*?Total PnL:\s*€([\-\d.]+)[\s\S]*?Combined win rate:\s*([\d.]+)%/);
    if (!m1) return null;
    return {
        decisionsGen: parseInt(m1[1]),
        decisionsExec: parseInt(m1[2]),
        trades: parseInt(m1[3]),
        pnl: parseFloat(m1[4]),
        winRate: parseFloat(m1[5])
    };
}

function parseSingleToken(out) {
    // Sole-token mode emits a single summary block (no AGGREGATE)
    const lines = out.split('\n');
    let trades = 0, pnl = 0, winRate = 0, decisionsGen = 0, decisionsExec = 0;
    for (const l of lines) {
        let m;
        if ((m = l.match(/^Trades:\s*(\d+)/))) trades = parseInt(m[1]);
        if ((m = l.match(/^Win rate:\s*([\d.]+)%/))) winRate = parseFloat(m[1]);
        if ((m = l.match(/^Total PnL:\s*€([\-\d.]+)/))) pnl = parseFloat(m[1]);
        if ((m = l.match(/(\d+) decisions generated,\s*(\d+) executed/))) {
            decisionsGen = parseInt(m[1]); decisionsExec = parseInt(m[2]);
        }
    }
    return trades ? { trades, pnl, winRate, decisionsGen, decisionsExec } : null;
}

(async () => {
    console.log(`\n=== Backtest experiments — ${DAYS}d window across ${EXPERIMENTS.length} configurations ===\n`);
    const results = [];
    for (let i = 0; i < EXPERIMENTS.length; i++) {
        const exp = EXPERIMENTS[i];
        process.stdout.write(`[${i+1}/${EXPERIMENTS.length}] ${exp.name.padEnd(55)}`);
        const r = runExperiment(exp);
        if (r.error) {
            console.log(` ! ERROR: ${r.error}`);
        } else {
            const sign = r.pnl >= 0 ? '+' : '';
            console.log(` ${r.trades.toString().padStart(3)}t  ${r.winRate.toFixed(1).padStart(5)}%w  €${(sign+r.pnl.toFixed(2)).padStart(8)}`);
        }
        results.push(r);
    }

    console.log('\n=== COMPARISON TABLE (sorted by PnL) ===\n');
    console.log('Rank  Trades  WinRate    PnL       Δ vs baseline   Configuration');
    console.log('----  ------  -------    --------  -------------   ' + '-'.repeat(60));
    const baseline = results.find(r => r.name === 'baseline (current live)');
    const baselinePnl = baseline?.pnl ?? 0;
    const sorted = results.filter(r => !r.error).sort((a, b) => b.pnl - a.pnl);
    for (let i = 0; i < sorted.length; i++) {
        const r = sorted[i];
        const delta = r.pnl - baselinePnl;
        const dSign = delta >= 0 ? '+' : '';
        console.log(`  ${(i+1).toString().padStart(2)}  ${r.trades.toString().padStart(5)}  ${r.winRate.toFixed(1).padStart(5)}%   €${(r.pnl>=0?'+':'')}${r.pnl.toFixed(2).padStart(7)}  ${(dSign + delta.toFixed(2)+'€').padStart(12)}   ${r.name}`);
    }

    const errors = results.filter(r => r.error);
    if (errors.length) {
        console.log('\nErrors:');
        for (const e of errors) console.log(`  ${e.name}: ${e.error}`);
    }
})();
