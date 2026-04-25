const storage = require('./storage');
const config = require('./config');

let state = {
    cashBalance: 0.00,              // Synced from real USDT on-chain balance at startup
    investedBalance: 0.00,          // Sum of open position initial investments
    totalValue: 0.00,
    pnl: 0.00,
    startEquity: 0.00,
    startTime: new Date().toISOString(),
    totalGasPaid: 0.00,
    totalFeesPaid: 0.00,
    positions: [],                  // see openPosition for shape
    history: [],                    // closed trades
    snapshots: []
};

function _gasFee() { return config.COSTS.GAS_PER_TX_USD; }
function _swapFeePct() { return config.COSTS.SWAP_FEE_PCT / 100; }

const portfolio = {
    init: () => {
        const loaded = storage.loadState();
        if (loaded) {
            state = { ...state, ...loaded };
            console.log('Portfolio state loaded from storage.');
        } else {
            console.log('No previous state found, starting fresh.');
        }
    },

    getPortfolio: () => {
        const currentEquity = state.cashBalance + state.investedBalance;
        const totalReturnPct = state.startEquity > 0
            ? ((currentEquity - state.startEquity) / state.startEquity) * 100
            : 0;
        const daysActive = Math.max(0.001, (new Date() - new Date(state.startTime)) / (1000 * 60 * 60 * 24));
        const avgDailyPct = totalReturnPct / daysActive;

        return {
            ...state,
            totalValue: currentEquity,
            pnl: state.pnl,
            metrics: {
                initialCap: parseFloat(state.startEquity.toFixed(2)),
                totalReturnPct,
                avgDailyPct,
                daysActive
            }
        };
    },

    setCashBalance: (amount) => {
        state.cashBalance = parseFloat(amount);
        state.startEquity = state.cashBalance + state.investedBalance;
        state.totalValue = state.startEquity;
        state.startTime = new Date().toISOString();
        portfolio.takeSnapshot();
        storage.saveState(state);
    },

    syncBalance: (newBalance) => {
        const diff = newBalance - state.cashBalance;
        if (Math.abs(diff) > 1.0) {
            console.log(`[Portfolio] External balance change detected: ${diff > 0 ? '+' : ''}$${diff.toFixed(2)}`);
            state.cashBalance = newBalance;
            state.startEquity += diff;
            state.totalValue = state.cashBalance + state.investedBalance;
            storage.saveState(state);
        }
    },

    takeSnapshot: () => {
        const equity = state.cashBalance + state.investedBalance;
        state.snapshots.push({
            time: new Date().toISOString(),
            equity,
            pnl: state.pnl
        });
        if (state.snapshots.length > 1000) state.snapshots.shift();
        storage.saveState(state);
    },

    // Open a position with real execution data.
    // args: { strategy, token, symbol, amountEur, entryPrice, txHash, stopLossPct, takeProfitPct, decisionScore }
    openPosition: (args) => {
        const gasFee = _gasFee();
        const swapFee = args.amountEur * _swapFeePct();
        const cost = args.amountEur + gasFee;

        if (state.cashBalance < cost) {
            return { success: false, reason: 'Insufficient cash' };
        }

        state.cashBalance -= cost;
        state.investedBalance += args.amountEur;
        state.totalGasPaid += gasFee;
        state.totalFeesPaid += swapFee;

        const position = {
            strategy: args.strategy,
            token: args.token,
            symbol: args.symbol || null,
            entryPrice: args.entryPrice,
            initialInvestment: args.amountEur,
            amountEur: args.amountEur,
            amountTokens: args.amountTokens || null,
            entryTxHash: args.txHash || null,
            stopLossPct: args.stopLossPct || config.EXITS.STOP_LOSS_PCT,
            takeProfitPct: args.takeProfitPct || config.EXITS.TAKE_PROFIT_PCT,
            highWaterMark: args.entryPrice,
            tookTP1: false,
            decisionScore: args.decisionScore || null,
            timestamp: new Date().toISOString(),
            status: 'OPEN'
        };

        state.positions.push(position);
        storage.saveState(state);
        return { success: true, position };
    },

    // Update high-water mark on each tick (used for trailing stops).
    updateHighWaterMark: (tokenAddress, currentPrice) => {
        const pos = state.positions.find(p => p.token.toLowerCase() === tokenAddress.toLowerCase());
        if (pos && currentPrice > (pos.highWaterMark || 0)) {
            pos.highWaterMark = currentPrice;
            storage.saveState(state);
        }
    },

    markTP1: (tokenAddress) => {
        const pos = state.positions.find(p => p.token.toLowerCase() === tokenAddress.toLowerCase());
        if (pos) {
            pos.tookTP1 = true;
            storage.saveState(state);
        }
    },

    // Close position using the REAL exit value from executed sell.
    closePosition: (tokenAddress, exitValueEur, exitTxHash, reason = '') => {
        const idx = state.positions.findIndex(p => p.token.toLowerCase() === tokenAddress.toLowerCase());
        if (idx === -1) return { success: false, reason: 'Position not found' };

        const pos = state.positions[idx];
        const gasFee = _gasFee();
        const swapFee = exitValueEur * _swapFeePct();
        const netProceeds = exitValueEur - gasFee; // exitValueEur already net of swap fee if from real amountOut

        state.cashBalance += netProceeds;
        state.investedBalance -= pos.initialInvestment;
        state.totalGasPaid += gasFee;
        state.totalFeesPaid += swapFee;

        const pnl = netProceeds - pos.initialInvestment;
        const pnlPercent = (pnl / pos.initialInvestment) * 100;

        state.history.unshift({
            token: pos.token,
            symbol: pos.symbol,
            strategy: pos.strategy,
            entryTime: pos.timestamp,
            exitTime: new Date().toISOString(),
            investment: pos.initialInvestment,
            exitValue: netProceeds,
            entryPrice: pos.entryPrice,
            exitPrice: pos.amountTokens ? exitValueEur / pos.amountTokens : null,
            pnl,
            pnlPercent,
            result: pnl > 0 ? 'WIN' : 'LOSS',
            reason,
            entryTxHash: pos.entryTxHash,
            exitTxHash
        });
        if (state.history.length > 100) state.history.pop();

        state.pnl += pnl;
        state.positions.splice(idx, 1);
        storage.saveState(state);

        return { success: true, pnl, pnlPercent };
    },

    getOpenPositions: () => state.positions.slice(),

    getMetrics: () => {
        const closed = state.history;
        const wins = closed.filter(t => t.pnl > 0);
        const losses = closed.filter(t => t.pnl <= 0);
        const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
        const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
        const winRate = closed.length > 0 ? wins.length / closed.length : 0;

        return {
            tradesClosed: closed.length,
            wins: wins.length,
            losses: losses.length,
            winRate,
            profitFactor,
            grossWin,
            grossLoss,
            totalPnl: state.pnl,
            openPositions: state.positions.length
        };
    }
};

module.exports = portfolio;
