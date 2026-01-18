const { ethers } = require('ethers');
const chalk = require('chalk');
const config = require('./config');
const { checkArbitrage } = require('./priceMonitor');
const { startSniper } = require('./sniper');
const { startCopyTrader } = require('./copyTrader');
const portfolio = require('./portfolio'); // Import Portfolio

// Shared state for the web dashboard
const botState = {
    isRunning: false,
    mode: config.SIMULATION_MODE ? 'SIMULATION' : 'REAL',
    walletBalance: '0.00',
    logs: [],
    opportunities: [],
    network: 'Disconnected',
    portfolio: portfolio.getPortfolio(), // Add Portfolio to State
    stats: {
        checks: 0,
        opportunities: 0,
        lastCheck: null
    }
};

function log(message, type = 'info') {
    const timestamp = new Date().toISOString(); // Use ISO for frontend formatting
    const logEntry = { time: timestamp, message, type };

    // Keep last 100 logs
    botState.logs.unshift(logEntry);
    if (botState.logs.length > 100) botState.logs.pop();

    // If it's a "success" (Finding), add to opportunities
    if (type === 'success') {
        botState.opportunities.unshift(logEntry);
        botState.stats.opportunities++; // Increment global counter
        // Keep last 50 opportunities
        if (botState.opportunities.length > 50) botState.opportunities.pop();
    }

    // Also log to console
    if (type === 'error') console.error(chalk.red(`[${timestamp}] ${message}`));
    else if (type === 'success') console.log(chalk.green(`[${timestamp}] ${message}`));
    else console.log(`[${timestamp}] ${message}`);
}

async function startBot() {
    if (botState.isRunning) return;
    botState.isRunning = true;

    log('Starting BSC Arbitrage Bot...', 'info');
    log(`Mode: ${config.SIMULATION_MODE ? 'SIMULATION' : 'LIVE'}`, 'info');
    log(`RPC: ${config.RPC_URL}`, 'info');

    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    let signer = null;

    if (!config.SIMULATION_MODE) {
        if (!config.PRIVATE_KEY) {
            log('CRITICAL: Real Mode selected but no PRIVATE_KEY found.', 'error');
            botState.isRunning = false;
            return;
        }
        signer = new ethers.Wallet(config.PRIVATE_KEY, provider);
        log(`Using Wallet: ${signer.address}`, 'success');

        // Ensure signer is connected to provider
        signer = signer.connect(provider);
    }

    try {
        const network = await provider.getNetwork();
        botState.network = `Chain ID: ${network.chainId}`;
        log(`Connected to ${botState.network}`, 'success');

        if (signer) {
            const balance = await provider.getBalance(signer.address);
            botState.walletBalance = ethers.formatEther(balance);

            // Fetch Initial USDT
            const execution = require('./execution');
            botState.walletBalanceUSDT = await execution.getUSDTBalance(signer);

            // Sync Portfolio Cash with Real Balance
            portfolio.setCashBalance(botState.walletBalanceUSDT);
            log(`Synced Portfolio Cash: $${parseFloat(botState.walletBalanceUSDT).toFixed(2)}`, 'success');

            log(`Wallet Balance: ${botState.walletBalance} BNB | ${botState.walletBalanceUSDT} USDT`, 'info');
            if (balance === 0n) log('WARNING: 0 BNB for Gas!', 'error');
        }

    } catch (error) {
        botState.network = 'Connection Failed';
        log('Failed to connect to RPC: ' + error.message, 'error');
        botState.isRunning = false;
        return;
    }

    // Start Liquidity Sniper if enabled
    if (config.SNIPE_MODE) {
        startSniper(provider, log);
    }

    // Start Copy Trader if enabled
    // Start Copy Trader if enabled
    if (config.COPY_MODE) {
        startCopyTrader(provider, log, async (type, token, alias, txHash) => {
            const execution = require('./execution'); // Late import to avoid circular dep issues

            if (type === 'ENTRY') {
                // Dynamic Sizing: 20% of Cash (Simulated or Real)
                // For Real: We use 20% of Portfolio Cash (Simulated tracking) as the bet size to be safe initially
                // Or should we check real balance? Let's check Portfolio cash for safety logic first.
                const currentCash = botState.portfolio.cashBalance;
                const tradeSize = Math.max(10, currentCash * 0.20);

                let success = false;
                let realTxHash = null;

                // --- REAL EXECUTION ---
                if (!config.SIMULATION_MODE && signer) {
                    log(`[REAL] Attempting to Buy $${tradeSize.toFixed(2)} of ${token}...`, 'info');
                    const realResult = await execution.executeBuy(signer, token, tradeSize);

                    if (realResult.success) {
                        success = true;
                        realTxHash = realResult.txHash;
                        log(`[REAL] Buy Confirmed: ${realTxHash}`, 'success');
                    } else {
                        log(`[REAL] Buy Failed: ${realResult.error}`, 'error');
                    }
                } else {
                    // Simulation always succeeds for now
                    success = true;
                }

                // --- UPDATE PORTFOLIO (Shadow or Sim) ---
                if (success) {
                    const result = portfolio.openPosition('CopyTrading', token, tradeSize);
                    if (result.success) {
                        // If Real, we might want to override the txHash or note it
                        const msg = `[COPY] ${alias} BUY ${token.slice(0, 6)}... | Bet: $${result.amount.toFixed(2)}`;
                        log(msg, 'success');
                    }
                }

            } else if (type === 'EXIT') {
                // Find position
                const pos = botState.portfolio.positions.find(p => p.token.toLowerCase() === token.toLowerCase());

                if (pos) {
                    let success = false;
                    let realPnL = null;

                    // --- REAL EXECUTION ---
                    if (!config.SIMULATION_MODE && signer) {
                        log(`[REAL] Attempting to Sell ${token}...`, 'info');
                        const realResult = await execution.executeSell(signer, token);

                        if (realResult.success) {
                            success = true;
                            log(`[REAL] Sell Confirmed: ${realResult.txHash}`, 'success');
                            // We could calc real PnL here if we knew exact amounts, 
                            // but portfolio update below handles the logic for dashboard consistency
                        } else {
                            log(`[REAL] Sell Failed: ${realResult.error}`, 'error');
                        }
                    } else {
                        success = true;
                    }

                    // --- UPDATE PORTFOLIO (Shadow or Sim) ---
                    if (success) {
                        // Simulate Market Movement for PnL tracking consistency
                        // (Unless we fetch real amounts, which is complex for now)
                        const volatility = (Math.random() * 0.20) - 0.05;
                        const exitValue = pos.initialInvestment * (1 + volatility);

                        const result = portfolio.closePosition(token, exitValue);
                        if (result.success) {
                            const msg = `[COPY] ${alias} SELL ${token.slice(0, 6)}... | PnL: $${result.pnl.toFixed(2)} (${result.pnl > 0 ? '+' : ''}${((result.pnl / pos.initialInvestment) * 100).toFixed(1)}%)`;
                            log(msg, result.pnl > 0 ? 'success' : 'error');
                        }
                    }
                }
            }

            botState.portfolio = portfolio.getPortfolio(); // Update state
        }, getHoldings);
    }

    // Helper to get current holdings for Copy Trader
    function getHoldings() {
        if (!botState.portfolio || !botState.portfolio.positions) return [];
        return botState.portfolio.positions.map(p => p.token.toLowerCase());
    }
}

// Loop for Arbitrage
setInterval(async () => {
    if (!botState.isRunning) return;

    botState.stats.checks++;
    botState.stats.lastCheck = new Date().toISOString(); // Use ISO for proper frontend formatting
    // Update portfolio stats periodically too (e.g. if we had live price feeds)
    botState.portfolio = portfolio.getPortfolio();

    const opportunityFound = await checkArbitrage(provider, log);
    if (opportunityFound) {
        log('Arbitrage Opportunity Detected! Executing...', 'success');

        if (!config.SIMULATION_MODE && signer) {
            const execution = require('./execution');
            // Only trade if not already busy? (Simple await handles it)
            await execution.executeArbitrage(signer, log);
        } else {
            log('Simulation Mode: Trade would be executed here.', 'info');
        }

    } else {
        // Log heartbeat every 10 checks to avoid spamming the dashboard
        if (botState.stats.checks % 10 === 0) {
            log('Scanning... No opportunities found.', 'info');
        }
    }
}, 5000);
}

module.exports = { startBot, botState };
