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

    // Main tick — runs every TICK_INTERVAL_MS
    setInterval(async () => {
        if (!botState.isRunning) return;

        try {
            await tick(provider, signer);
        } catch (err) {
            log(`Tick error: ${err.message}`, 'error');
        }
    }, config.TICK_INTERVAL_MS);
}

async function tick(provider, signer) {
    botState.stats.checks++;
    botState.stats.lastCheck = new Date().toISOString();
    botState.portfolio = portfolio.getPortfolio();

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

    // Periodic heartbeat
    if (botState.stats.checks % 12 === 0) {
        const m = portfolio.getMetrics();
        const open = portfolio.getOpenPositions().length;
        log(`Heartbeat: ${botState.stats.checks} ticks, ${m.tradesClosed} closed (${(m.winRate * 100).toFixed(0)}% win), ${open} open, PnL €${m.totalPnl.toFixed(2)}`, 'info');
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

    if (decisions.length === 0) return;

    // Attach sizing and filter through risk manager
    for (const decision of decisions) {
        decision.sizeEur = riskManager.sizePosition(decision.score, port.cashBalance);

        const gate = signalEngine.passesGate(decision, null);
        if (!gate.ok) {
            if (decision.score >= config.SIGNAL.MIN_SCORE) {
                log(`[${decision.strategy}] ${decision.symbol} blocked: ${gate.reason}`, 'info');
            }
            continue;
        }

        const canOpen = riskManager.canOpen(decision, port, bnbBalance);
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
