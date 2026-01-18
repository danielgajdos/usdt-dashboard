const state = {
    cashBalance: 1000.00, // Initial USD
    investedBalance: 0.00,
    totalValue: 1000.00,
    pnl: 0.00,
    startEquity: 1000.00, // Tracks initial for % calc
    startTime: new Date().toISOString(),
    totalGasPaid: 0.00,
    totalFeesPaid: 0.00,
    positions: [],
    history: [],
    snapshots: [] // { time, value, pnl }
};

const GAS_FEE_USD = 0.50; // Estimated Gas per tx
const SWAP_FEE_PCT = 0.0025; // 0.25% PancakeSwap Fee

const portfolio = {
    getPortfolio: () => {
        // Calculate Metrics
        const currentEquity = state.cashBalance + state.investedBalance;
        const totalReturnPct = ((currentEquity - state.startEquity) / state.startEquity) * 100;

        // Avg Daily % (Simple Calc for short duration: Total % / Days Active)
        const daysActive = Math.max(0.001, (new Date() - new Date(state.startTime)) / (1000 * 60 * 60 * 24));
        const avgDailyPct = totalReturnPct / daysActive;

        return {
            ...state,
            totalValue: currentEquity,
            pnl: state.pnl,
            metrics: {
                initialCap: state.startEquity,
                totalReturnPct,
                avgDailyPct,
                daysActive
            }
        };
    },

    setCashBalance: (amount) => {
        state.cashBalance = parseFloat(amount);
        state.startEquity = state.cashBalance + state.investedBalance; // Reset start equity on sync
        state.totalValue = state.startEquity;
        state.startTime = new Date().toISOString(); // Reset timer
        // Take initial snapshot
        portfolio.takeSnapshot();
    },

    takeSnapshot: () => {
        const equity = state.cashBalance + state.investedBalance;
        state.snapshots.push({
            time: new Date().toISOString(),
            equity: equity,
            pnl: state.pnl
        });
        // Keep last 1000 snapshots
        if (state.snapshots.length > 1000) state.snapshots.shift();
    },

    openPosition: (strategy, tokenAddress, amountUSD) => {
        // Check for funds
        const cost = amountUSD + GAS_FEE_USD;
        if (state.cashBalance < cost) {
            return { success: false, reason: 'Insufficient Funds' };
        }

        // Deduct Entry
        state.cashBalance -= cost;
        state.investedBalance += amountUSD;
        state.totalGasPaid += GAS_FEE_USD;
        state.totalFeesPaid += (amountUSD * SWAP_FEE_PCT);
        state.totalValue -= GAS_FEE_USD + (amountUSD * SWAP_FEE_PCT); // Immediate PnL hit from fees

        const position = {
            strategy,
            token: tokenAddress,
            entryPrice: 'Unknown (Sim)',
            amountUSD: amountUSD * (1 - SWAP_FEE_PCT), // Actual value after fee
            initialInvestment: amountUSD,
            timestamp: new Date().toISOString(),
            status: 'OPEN'
        };

        state.positions.push(position);

        return {
            success: true,
            position,
            amount: amountUSD,
            costs: { gas: GAS_FEE_USD, fee: amountUSD * SWAP_FEE_PCT }
        };
    },

    recordAtomicTrade: (pnl, txHash) => {
        state.pnl += pnl;
        state.cashBalance += pnl; // Update cash (simplified)
        state.totalValue = state.cashBalance + state.investedBalance;

        state.history.unshift({
            time: new Date().toISOString(),
            type: 'ARBITRAGE',
            token: 'BNB/USDT',
            amount: 0, // No position held
            price: 'N/A',
            pnl: pnl,
            txHash: txHash
        });

        // Keep history size manageable
        if (state.history.length > 50) state.history.pop();
    },

    closePosition: (tokenAddress, exitValueUSD) => {
        const idx = state.positions.findIndex(p => p.token.toLowerCase() === tokenAddress.toLowerCase());
        if (idx === -1) return { success: false, reason: 'Position not found' };

        const pos = state.positions[idx];

        // Calculate Exit Details
        const exitFee = exitValueUSD * SWAP_FEE_PCT;
        const netProceeds = exitValueUSD - exitFee - GAS_FEE_USD;

        // Update Portfolio
        state.cashBalance += netProceeds;
        state.investedBalance -= pos.initialInvestment; // Remove original cost from invested
        state.totalGasPaid += GAS_FEE_USD;
        state.totalFeesPaid += exitFee;

        // PnL Calculation
        const pnl = netProceeds - pos.initialInvestment; // Net PnL
        const pnlPercent = (pnl / pos.initialInvestment) * 100;

        // Record History
        const historyEntry = {
            token: pos.token,
            strategy: pos.strategy,
            entryTime: pos.timestamp,
            exitTime: new Date().toISOString(),
            investment: pos.initialInvestment,
            exitValue: netProceeds,
            pnl: pnl,
            pnlPercent: pnlPercent,
            result: pnl > 0 ? 'WIN' : 'LOSS'
        };

        state.history.unshift(historyEntry); // Add to top
        if (state.history.length > 50) state.history.pop();

        // Update Total Value PnL tracking for dashboard (optional, but getPortfolio derives it)
        state.pnl += pnl;

        // Remove from Open Positions
        state.positions.splice(idx, 1);

        return { success: true, pnl };
    }
};

module.exports = portfolio;
