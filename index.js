const { ethers } = require('ethers');
const chalk = require('chalk');
const config = require('./config');
const { TOKENS } = require('./tokens');
const portfolio = require('./portfolio');
const marketData = require('./marketData');
const signalEngine = require('./signalEngine');
const riskManager = require('./riskManager');
const honeypot = require('./safety/honeypot');
const execution = require('./execution');

// Register strategies
const momentumStrategy = require('./strategies/momentum');
const meanReversionStrategy = require('./strategies/meanReversion');
const newsDrivenStrategy = require('./strategies/newsDriven');
const stableArbStrategy = require('./strategies/stableArb');
signalEngine.register(momentumStrategy);
signalEngine.register(meanReversionStrategy);
signalEngine.register(newsDrivenStrategy);
signalEngine.register(stableArbStrategy);

// Start background services
const newsLLM = require('./signals/newsLLM');
const whaleCluster = require('./signals/whaleCluster');

const botState = {
    isRunning: false,
    mode: config.SIMULATION_MODE ? 'SIMULATION' : 'LIVE',
    walletBalance: '0.00',
    walletBalanceUSDT: '0.00',
    logs: [],
    opportunities: [],
    network: 'Disconnected',
    portfolio: portfolio.getPortfolio(),
    stats: {
        checks: 0,
        decisionsGenerated: 0,
        decisionsExecuted: 0,
        opportunities: 0,        // entries actually executed (dashboard compat)
        lastCheck: null
    }
};

function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const entry = { time: timestamp, message, type };
    botState.logs.unshift(entry);
    if (botState.logs.length > 200) botState.logs.pop();

    if (type === 'success') {
        botState.opportunities.unshift(entry);
        if (botState.opportunities.length > 50) botState.opportunities.pop();
    }

    if (type === 'error') console.error(chalk.red(`[${timestamp}] ${message}`));
    else if (type === 'success') console.log(chalk.green(`[${timestamp}] ${message}`));
    else if (type === 'warning') console.log(chalk.yellow(`[${timestamp}] ${message}`));
    else console.log(`[${timestamp}] ${message}`);
}

async function startBot() {
    if (botState.isRunning) return;
    botState.isRunning = true;

    portfolio.init();

    log(`Starting BSC Momentum Bot (${botState.mode})`, 'info');
    log(`Strategies registered: ${signalEngine.listStrategies().join(', ')}`, 'info');
    newsLLM.start(msg => log(msg, 'info'));
    log(`Universe: ${TOKENS.map(t => t.symbol).join(', ')}`, 'info');
    log(`Risk: €${config.RISK.MAX_POSITION_EUR} max/pos × ${config.RISK.MAX_CONCURRENT_POSITIONS} pos, SL ${config.EXITS.STOP_LOSS_PCT}% / TP ${config.EXITS.TAKE_PROFIT_PCT}%`, 'info');

    if (config.RISK.SHADOW_LIVE_CAP_EUR !== null) {
        log(`⚠ SHADOW LIVE MODE: position cap reduced to €${config.RISK.SHADOW_LIVE_CAP_EUR}`, 'warning');
    }

    if (config.STOP_BOT) {
        log('⚠ STOP_BOT flag is set — no entries will be executed.', 'warning');
    }

    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    let signer = null;

    if (!config.SIMULATION_MODE) {
        if (!config.PRIVATE_KEY) {
            log('CRITICAL: Live mode but PRIVATE_KEY not set. Halting.', 'error');
            botState.isRunning = false;
            return;
        }
        signer = new ethers.Wallet(config.PRIVATE_KEY, provider);
        log(`Wallet: ${signer.address}`, 'success');
    }

    try {
        const network = await provider.getNetwork();
        botState.network = `Chain ID: ${network.chainId}`;
        log(`Connected: ${botState.network}`, 'success');

        if (signer) {
            const bnb = await provider.getBalance(signer.address);
            botState.walletBalance = ethers.formatEther(bnb);
            botState.walletBalanceUSDT = await execution.getUSDTBalance(signer);

            portfolio.setCashBalance(botState.walletBalanceUSDT);
            log(`Balance: ${parseFloat(botState.walletBalance).toFixed(4)} BNB | ${parseFloat(botState.walletBalanceUSDT).toFixed(2)} USDT`, 'info');

            if (parseFloat(botState.walletBalance) < config.RISK.MIN_BNB_GAS_RESERVE) {
                log(`⚠ BNB gas reserve below ${config.RISK.MIN_BNB_GAS_RESERVE} — entries will be blocked until topped up.`, 'warning');
            }
        }
    } catch (err) {
        botState.network = 'Connection Failed';
        log(`RPC connection failed: ${err.message}`, 'error');
        botState.isRunning = false;
        return;
    }

    // Set initial portfolio state for riskManager daily-reset
    const initialEquity = portfolio.getPortfolio().totalValue;
    riskManager.rollDay(initialEquity);

    // Main tick — runs every TICK_INTERVAL_MS.
    // A tick-in-flight guard prevents overlapping invocations: when an entry is
    // executing an on-chain swap (awaitable receipt takes 3-10s), the next 5s
    // interval would fire concurrently and the still-pending position wouldn't
    // be in portfolio.positions yet — letting strategies double-buy the same
    // token (this caused the 2026-04-29 CAKE duplicate that orphaned a position).
    let tickInFlight = false;
    setInterval(async () => {
        if (!botState.isRunning || tickInFlight) return;
        tickInFlight = true;
        try {
            await tick(provider, signer);
        } catch (err) {
            log(`Tick error: ${err.message}`, 'error');
        } finally {
            tickInFlight = false;
        }
    }, config.TICK_INTERVAL_MS);
}

// Augment open positions with live price, P/L, hold time, and countdown to timeout.
// Done here (every tick) so the API/dashboard reads fresh values without re-computing.
function enrichPositions(pf) {
    const maxHoldMs = config.EXITS.MAX_HOLD_MINUTES * 60_000;
    pf.positions = pf.positions.map(p => {
        const last = marketData.getLastPrice(p.token);
        const ageMs = Date.now() - new Date(p.timestamp).getTime();
        const heldMin = Math.floor(ageMs / 60_000);
        const timeoutMin = Math.max(0, Math.ceil((maxHoldMs - ageMs) / 60_000));
        let pnlPct = null, pnlEur = null, currentPrice = last || null;
        if (last && p.entryPrice) {
            pnlPct = ((last - p.entryPrice) / p.entryPrice) * 100;
            pnlEur = p.amountEur * (pnlPct / 100);
        }
        const slLevel = p.entryPrice ? p.entryPrice * (1 - (p.stopLossPct || config.EXITS.STOP_LOSS_PCT) / 100) : null;
        const tpLevel = p.entryPrice ? p.entryPrice * (1 + (p.takeProfitPct || config.EXITS.TAKE_PROFIT_PCT) / 100) : null;
        return { ...p, currentPrice, pnlPct, pnlEur, heldMin, timeoutMin, slLevel, tpLevel };
    });
    return pf;
}

async function tick(provider, signer) {
    botState.stats.checks++;
    botState.stats.lastCheck = new Date().toISOString();
    botState.portfolio = enrichPositions(portfolio.getPortfolio());

    // Refresh wallet balances every 5 ticks (~25s)
    if (signer && botState.stats.checks % 5 === 0) {
        try {
            const bnb = await provider.getBalance(signer.address);
            botState.walletBalance = ethers.formatEther(bnb);
            const usdt = await execution.getUSDTBalance(signer);
            botState.walletBalanceUSDT = usdt;
            portfolio.syncBalance(parseFloat(usdt));
        } catch {}
    }

    // Refresh market data for all universe tokens in parallel
    await Promise.all(
        TOKENS.map(t => marketData.refreshPrice(provider, t.address, t.decimals))
    );

    // Whale cluster: poll every ~30s (6 ticks × 5s)
    if (botState.stats.checks % 6 === 0) {
        whaleCluster.update(provider).catch(() => {}); // non-blocking, silent on RPC failure
    }

    // 1. Check exits first (prioritize protecting capital over new entries)
    await processExits(signer);

    // 2. Scan for new entries
    await processEntries(provider, signer);

    // Equity snapshot every 60 ticks (~5 min) for the dashboard chart.
    // Cap at 1000 entries (~3.5 days at 5-min cadence) is enforced inside takeSnapshot.
    if (botState.stats.checks % 60 === 0) {
        portfolio.takeSnapshot();
    }

    // Periodic heartbeat — every minute (~12 ticks × 5s)
    if (botState.stats.checks % 12 === 0) {
        const m = portfolio.getMetrics();
        const openPositions = portfolio.getOpenPositions();
        log(`Heartbeat: ${botState.stats.checks} ticks | decisionsGen=${botState.stats.decisionsGenerated} exec=${botState.stats.decisionsExecuted} | ${m.tradesClosed} closed (${(m.winRate * 100).toFixed(0)}% win) ${openPositions.length} open | PnL €${m.totalPnl.toFixed(2)}`, 'info');

        // Per-position breakdown — entry, current price, unrealized P/L, hold time, dist to SL/TP
        for (const pos of openPositions) {
            const last = marketData.getLastPrice(pos.token);
            const heldMin = Math.floor((Date.now() - new Date(pos.timestamp).getTime()) / 60000);
            if (!last || !pos.entryPrice) {
                log(`  └ ${pos.symbol}: entry $${(pos.entryPrice || 0).toFixed(4)} | held ${heldMin}m | (no live price)`, 'info');
                continue;
            }
            const movePct = ((last - pos.entryPrice) / pos.entryPrice) * 100;
            // Unrealized EUR P/L: investment × movePct − round-trip cost (~3.5%) only realized on exit.
            // Show gross unrealized; the actual exit cost is applied in closePosition.
            const unrealizedEur = pos.amountEur * (movePct / 100);
            const slLevel = pos.entryPrice * (1 - pos.stopLossPct / 100);
            const tpLevel = pos.entryPrice * (1 + pos.takeProfitPct / 100);
            const distSl = ((last - slLevel) / pos.entryPrice) * 100;
            const distTp = ((tpLevel - last) / pos.entryPrice) * 100;
            const sign = movePct >= 0 ? '+' : '';
            log(`  └ ${pos.symbol}: entry $${pos.entryPrice.toFixed(4)} → now $${last.toFixed(4)} | P/L ${sign}${movePct.toFixed(2)}% (${sign}€${unrealizedEur.toFixed(2)}) | held ${heldMin}m | SL ${distSl.toFixed(2)}% / TP ${distTp.toFixed(2)}% away`, 'info');
        }
    }

    // Indicator snapshot every 10 min (~120 ticks) — shows why strategies aren't firing
    if (botState.stats.checks % 120 === 0) {
        const samples = TOKENS; // all tokens as canary
        for (const t of samples) {
            const ind = marketData.computeIndicators(t.address);
            if (!ind) {
                log(`[Diag] ${t.symbol}: insufficient data (need 65 bars, have ${marketData.getHistory(t.address).length})`, 'info');
                continue;
            }
            const atrPct = ind.atr && ind.price ? (ind.atr / ind.price * 100).toFixed(3) : '?';
            log(`[Diag] ${t.symbol}: price=${ind.price?.toFixed(4)} RSI=${ind.rsi?.toFixed(1)} EMAf=${ind.emaFast?.toFixed(4)} EMAs=${ind.emaSlow?.toFixed(4)} ATR%=${atrPct} depth=${ind.depthOk} n=${ind.samples}`, 'info');
        }
    }
}

async function processExits(signer) {
    const positions = portfolio.getOpenPositions();
    if (positions.length === 0) return;

    for (const pos of positions) {
        const indicators = marketData.computeIndicators(pos.token);
        const currentPrice = indicators ? indicators.price : marketData.getLastPrice(pos.token);
        if (!currentPrice) continue;

        portfolio.updateHighWaterMark(pos.token, currentPrice);

        const check = riskManager.shouldExit(pos, currentPrice, indicators ? indicators.atr : null);
        if (!check.shouldExit) continue;

        log(`EXIT ${pos.symbol || pos.token.slice(0, 8)}: ${check.reason}`, check.reason.startsWith('SL') ? 'error' : 'success');

        const decision = signalEngine.emptyDecision({
            action: 'EXIT',
            strategy: 'EXIT',
            token: pos.token,
            symbol: pos.symbol,
            reason: check.reason,
            partial: check.partial || 1.0
        });

        const result = await execution.executeDecision(signer, decision);

        if (!result.success) {
            // "No balance to sell" = orphan record (e.g. duplicate-buy that got sold by a sibling
            // exit on the prior tick). The on-chain tokens are already gone, so retrying forever
            // just spams logs. Close the orphan with the recorded investment as exit value so
            // the bookkeeping stays neutral, then move on.
            if (/no balance/i.test(result.error || '')) {
                log(`Orphan ${pos.symbol}: on-chain balance is 0 — clearing stale position record (no PnL — sibling already booked it)`, 'warning');
                portfolio.removeOrphan(pos.token);
                portfolio.takeSnapshot();
                continue;
            }
            log(`Exit failed for ${pos.symbol}: ${result.error}`, 'error');
            continue;
        }

        // Partial exit → mark TP1 and keep remaining position open
        if (check.partial && check.partial < 1.0) {
            portfolio.markTP1(pos.token);
            log(`Partial exit ${(check.partial * 100).toFixed(0)}% of ${pos.symbol}: €${(result.exitValueEur || 0).toFixed(2)}`, 'success');
        } else {
            const exitEur = result.exitValueEur || pos.initialInvestment;
            const closed = portfolio.closePosition(pos.token, exitEur, result.txHash, check.reason);
            if (closed.success) {
                const pnlColor = closed.pnl > 0 ? 'success' : 'error';
                log(`Closed ${pos.symbol}: PnL €${closed.pnl.toFixed(2)} (${closed.pnlPercent.toFixed(2)}%) — ${check.reason}`, pnlColor);
                if (closed.pnl <= 0) riskManager.recordLoss(pos.token);
                portfolio.takeSnapshot(); // capture the inflection point on the equity curve
            }
        }
    }
}

async function processEntries(provider, signer) {
    if (config.STOP_BOT) return;

    const port = portfolio.getPortfolio();
    const bnbBalance = parseFloat(botState.walletBalance);

    // Generate decisions from all registered strategies
    const ctx = { provider, signer, portfolio, log };
    const decisions = await signalEngine.scan(ctx);

    botState.stats.decisionsGenerated += decisions.length;

    // Verbose decision log every 60 ticks (~5 min): show top decision even if blocked
    const verboseTick = botState.stats.checks % 60 === 0;
    if (verboseTick) {
        if (decisions.length === 0) {
            log('[Diag] scan returned 0 decisions (all strategies returned null — check indicator data)', 'info');
        } else {
            const top = decisions[0];
            log(`[Diag] top decision: [${top.strategy}] ${top.symbol} score=${top.score} edge=${top.expectedEdgePct?.toFixed(2)}% conf=${top.confidence?.toFixed(2)} | ${top.reason}`, 'info');
        }
    }

    if (decisions.length === 0) return;

    // Attach sizing and filter through risk manager.
    // `livePort` is re-read after each successful entry so subsequent decisions
    // see the freshly-opened positions — prevents two strategies from buying the
    // same token in one tick (which orphans the second record on exit).
    let livePort = port;
    for (const decision of decisions) {
        decision.sizeEur = riskManager.sizePosition(decision.score, livePort.cashBalance);

        const gate = signalEngine.passesGate(decision, null);
        if (!gate.ok) {
            // Log all gate blocks (not just score >= MIN_SCORE) — helps diagnose issues.
            // But only for top-scoring decisions to avoid log spam on weak signals.
            if (decision.score >= config.SIGNAL.MIN_SCORE - 15) {
                log(`[${decision.strategy}] ${decision.symbol} gate block (score=${decision.score}): ${gate.reason}`, 'info');
            }
            continue;
        }

        const canOpen = riskManager.canOpen(decision, livePort, bnbBalance);
        if (!canOpen.ok) {
            log(`[${decision.strategy}] ${decision.symbol} risk block: ${canOpen.reason}`, 'info');
            continue;
        }

        // Honeypot check (allowlisted tokens fast-path)
        const hp = await honeypot.check(provider, decision.token, signer ? signer.address : null);
        if (!hp.passed) {
            log(`[${decision.strategy}] ${decision.symbol} honeypot rejected: ${hp.details.reason}`, 'warning');
            continue;
        }

        log(`🎯 ENTER ${decision.symbol} — score ${decision.score}, edge ${decision.expectedEdgePct.toFixed(2)}%, size €${decision.sizeEur.toFixed(2)} | ${decision.reason}`, 'success');

        const result = await execution.executeDecision(signer, decision);
        if (!result.success) {
            log(`[${decision.strategy}] execution failed: ${result.error}`, 'error');
            continue;
        }

        botState.stats.decisionsExecuted++;
        botState.stats.opportunities++;

        portfolio.openPosition({
            strategy: decision.strategy,
            token: decision.token,
            symbol: decision.symbol,
            amountEur: decision.sizeEur,
            entryPrice: result.entryPrice || 0,
            amountTokens: result.amountTokens || null,
            txHash: result.txHash,
            stopLossPct: decision.stopLossPct,
            takeProfitPct: decision.takeProfitPct,
            decisionScore: decision.score
        });

        // Refresh portfolio snapshot so the next decision sees this entry —
        // critical to prevent same-tick double-buys of the same token.
        livePort = portfolio.getPortfolio();
        portfolio.takeSnapshot(); // capture the entry on the equity curve

        log(`✅ Opened ${decision.symbol}: ${result.amountTokens?.toFixed(4) || '?'} tokens @ ${result.entryPrice?.toFixed(6) || '?'} | tx: ${result.txHash}`, 'success');

        // Refresh portfolio for subsequent decision checks in this tick
        botState.portfolio = portfolio.getPortfolio();

        // Only open one position per tick to spread risk and conserve gas
        break;
    }
}

// Emergency "STOP & CLOSE ALL" — fires market sells on every open position and
// halts new entries. Used by the dashboard's red panic button.
async function emergencyStopAndCloseAll() {
    log('🚨 EMERGENCY STOP triggered — halting entries and closing all positions', 'error');
    botState.isRunning = false;
    riskManager.halt('emergency stop', 24 * 60 * 60 * 1000);

    // We need a signer + provider; reconstruct from config.
    let signer = null;
    let provider = null;
    try {
        provider = new ethers.JsonRpcProvider(config.RPC_URL);
        if (config.PRIVATE_KEY) signer = new ethers.Wallet(config.PRIVATE_KEY, provider);
    } catch (err) {
        log(`Emergency: could not init signer: ${err.message}`, 'error');
    }

    const positions = portfolio.getOpenPositions();
    const results = [];

    for (const pos of positions) {
        const decision = signalEngine.emptyDecision({
            action: 'EXIT',
            strategy: 'EMERGENCY',
            token: pos.token,
            symbol: pos.symbol,
            partial: 1.0,
            reason: 'emergency stop'
        });
        try {
            const r = await execution.executeDecision(signer, decision);
            if (r.success) {
                const exitEur = r.exitValueEur || pos.initialInvestment;
                portfolio.closePosition(pos.token, exitEur, r.txHash, 'emergency stop');
                log(`Emergency closed ${pos.symbol}: tx ${r.txHash}`, 'success');
                results.push({ token: pos.token, symbol: pos.symbol, success: true, txHash: r.txHash });
            } else {
                log(`Emergency close FAILED for ${pos.symbol}: ${r.error}`, 'error');
                results.push({ token: pos.token, symbol: pos.symbol, success: false, error: r.error });
            }
        } catch (err) {
            log(`Emergency close exception ${pos.symbol}: ${err.message}`, 'error');
            results.push({ token: pos.token, symbol: pos.symbol, success: false, error: err.message });
        }
    }

    return { closed: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results };
}

function stopBot() {
    botState.isRunning = false;
    log('Bot stopped (entries halted, open positions still trail their exits when restarted)', 'warning');
}

module.exports = { startBot, stopBot, emergencyStopAndCloseAll, botState };
