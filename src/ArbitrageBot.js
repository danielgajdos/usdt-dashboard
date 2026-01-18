const { ethers } = require('ethers');
const winston = require('winston');

// Configure logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/bot.log' })
    ]
});

class ArbitrageBot {
    constructor(config) {
        this.config = config;
        this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
        this.wallet = new ethers.Wallet(config.privateKey, this.provider);

        // Contract ABI (simplified for key functions)
        this.contractABI = [
            "function checkArbitrageOpportunity(address tokenA, address tokenB, uint256 amountIn) external view returns (bool profitable, uint256 expectedProfit, bool buyOnPancake, uint256 profitBPS)",
            "function executeArbitrage(tuple(address tokenA, address tokenB, uint256 amountIn, bool buyOnPancake) params) external",
            "function getStats() external view returns (uint256 totalTrades, uint256 successfulTrades, uint256 totalProfit, uint256 successRate)",
            "function getTokenBalance(address token) external view returns (uint256)",
            "function pause() external",
            "function unpause() external",
            "event ArbitrageExecuted(address indexed tokenA, address indexed tokenB, uint256 amountIn, uint256 profit, string strategy, uint256 timestamp)",
            "event OpportunityFound(address indexed tokenA, address indexed tokenB, uint256 amountIn, uint256 expectedProfit, bool buyOnPancake)"
        ];

        this.contract = new ethers.Contract(
            config.contractAddress,
            this.contractABI,
            this.wallet
        );

        this.isRunning = false;
        this.stats = {
            opportunitiesFound: 0,
            tradesExecuted: 0,
            totalProfit: 0,
            totalGasSpent: 0,
            errors: 0
        };

        // Trading pairs based on analysis
        this.tradingPairs = [
            {
                tokenA: '0x7ef95a0FEE0Dd31b22626fA2e10Ee6A223F8a684', // USDT Testnet
                tokenB: '0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd', // WBNB Testnet
                name: 'USDT/WBNB',
                enabled: true
            }
        ];

        // Optimal trading hours from analysis (17:00-18:00 UTC)
        this.optimalHours = [17, 18];

        logger.info('🤖 ArbitrageBot initialized');
        logger.info(`📍 Contract: ${config.contractAddress}`);
        logger.info(`🌐 Network: ${config.network}`);
    }

    async start() {
        if (this.isRunning) {
            logger.warn('Bot is already running');
            return;
        }

        logger.info('🚀 Starting ArbitrageBot...');

        try {
            // Check wallet balance
            const balance = await this.wallet.getBalance();
            logger.info(`💰 Wallet Balance: ${ethers.utils.formatEther(balance)} BNB`);

            if (balance.lt(ethers.utils.parseEther('0.01'))) {
                throw new Error('Insufficient BNB balance for gas fees');
            }

            // Check contract balance
            const usdtBalance = await this.contract.getTokenBalance(this.tradingPairs[0].tokenA);
            logger.info(`💵 Contract USDT Balance: ${ethers.utils.formatUnits(usdtBalance, 18)}`);

            this.isRunning = true;

            // Start monitoring
            this.monitorPrices();

            // Setup event listeners
            this.setupEventListeners();

            logger.info('✅ Bot started successfully');

        } catch (error) {
            logger.error(`❌ Failed to start bot: ${error.message}`);
            throw error;
        }
    }

    async monitorPrices() {
        while (this.isRunning) {
            try {
                const currentHour = new Date().getUTCHours();
                const isOptimalHour = this.optimalHours.includes(currentHour);

                if (isOptimalHour) {
                    logger.info(`🔥 Peak trading hour (${currentHour}:00 UTC) - Active monitoring`);
                }

                for (const pair of this.tradingPairs) {
                    if (!pair.enabled) continue;

                    await this.checkAndExecuteArbitrage(pair, isOptimalHour);
                }

                // Adjust monitoring frequency based on time
                const interval = isOptimalHour ? 3000 : 10000; // 3s during peak, 10s otherwise
                await this.sleep(interval);

            } catch (error) {
                logger.error(`❌ Error in monitoring: ${error.message}`);
                this.stats.errors++;
                await this.sleep(10000); // Wait longer on error
            }
        }
    }

    async checkAndExecuteArbitrage(pair, isOptimalHour) {
        try {
            const tradeAmount = ethers.utils.parseUnits(
                this.config.tradeAmountUSDT.toString(),
                18
            );

            // Check for arbitrage opportunity
            const [profitable, expectedProfit, buyOnPancake, profitBPS] =
                await this.contract.checkArbitrageOpportunity(
                    pair.tokenA,
                    pair.tokenB,
                    tradeAmount
                );

            if (profitable) {
                const profitPercent = profitBPS / 100; // Convert BPS to percentage

                logger.info(`💰 Opportunity found for ${pair.name}:`);
                logger.info(`   Profit: ${profitPercent.toFixed(3)}% ($${ethers.utils.formatUnits(expectedProfit, 18)})`);
                logger.info(`   Direction: ${buyOnPancake ? 'Pancake → Uniswap' : 'Uniswap → Pancake'}`);

                this.stats.opportunitiesFound++;

                // Only execute during optimal hours or if profit is very high
                if (isOptimalHour || profitPercent > 0.5) {
                    await this.executeArbitrage({
                        tokenA: pair.tokenA,
                        tokenB: pair.tokenB,
                        amountIn: tradeAmount,
                        buyOnPancake: buyOnPancake
                    }, pair.name);
                } else {
                    logger.info(`⏰ Waiting for optimal trading hours (profit: ${profitPercent.toFixed(3)}%)`);
                }
            }

        } catch (error) {
            if (!error.message.includes('Not profitable')) {
                logger.error(`❌ Error checking ${pair.name}: ${error.message}`);
                logger.error(error.stack); // Log stack trace for debugging
            }
        }
    }

    async executeArbitrage(params, pairName) {
        try {
            logger.info(`🔄 Executing arbitrage for ${pairName}...`);

            // Estimate gas
            const gasEstimate = await this.contract.estimateGas.executeArbitrage(params);
            const gasPrice = await this.provider.getGasPrice();

            // Check if gas price is reasonable
            const maxGasPrice = ethers.utils.parseUnits(this.config.maxGasPriceGwei.toString(), 'gwei');
            if (gasPrice.gt(maxGasPrice)) {
                logger.warn(`⛽ Gas price too high: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`);
                return;
            }

            // Execute transaction
            const tx = await this.contract.executeArbitrage(params, {
                gasLimit: gasEstimate.mul(120).div(100), // 20% buffer
                gasPrice: gasPrice
            });

            logger.info(`📤 Transaction sent: ${tx.hash}`);
            logger.info(`⏳ Waiting for confirmation...`);

            // Wait for confirmation
            const receipt = await tx.wait();

            if (receipt.status === 1) {
                logger.info(`✅ Arbitrage successful!`);
                logger.info(`   Gas used: ${receipt.gasUsed.toString()}`);
                logger.info(`   Gas price: ${ethers.utils.formatUnits(receipt.effectiveGasPrice, 'gwei')} gwei`);

                this.stats.tradesExecuted++;
                this.stats.totalGasSpent = this.stats.totalGasSpent + receipt.gasUsed.mul(receipt.effectiveGasPrice);

                // Parse events for profit information
                const arbitrageEvent = receipt.events?.find(e => e.event === 'ArbitrageExecuted');
                if (arbitrageEvent) {
                    const profit = ethers.utils.formatUnits(arbitrageEvent.args.profit, 18);
                    this.stats.totalProfit += parseFloat(profit);
                    logger.info(`💰 Profit: $${profit}`);
                }

            } else {
                logger.error('❌ Transaction failed');
            }

        } catch (error) {
            logger.error(`❌ Execution error: ${error.message}`);
            logger.error(error.stack); // Log stack trace for debugging
            this.stats.errors++;
        }
    }

    setupEventListeners() {
        // Listen for arbitrage events
        this.contract.on('ArbitrageExecuted', (tokenA, tokenB, amountIn, profit, strategy, timestamp) => {
            logger.info(`🎉 Arbitrage Event: Profit $${ethers.utils.formatUnits(profit, 18)}`);
        });

        this.contract.on('OpportunityFound', (tokenA, tokenB, amountIn, expectedProfit, buyOnPancake) => {
            logger.info(`🔍 Opportunity Event: Expected profit $${ethers.utils.formatUnits(expectedProfit, 18)}`);
        });
    }

    async getStats() {
        try {
            const [totalTrades, successfulTrades, totalProfit, successRate] = await this.contract.getStats();
            const gasSpentBNB = ethers.utils.formatEther(this.stats.totalGasSpent);

            // Get USDT balance from contract
            const usdtAddress = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd"; // New USDT contract
            const usdtBalance = await this.contract.getTokenBalance(usdtAddress);
            const usdtBalanceFormatted = ethers.utils.formatUnits(usdtBalance, 18);

            return {
                // Contract stats
                contractTotalTrades: totalTrades.toString(),
                contractSuccessfulTrades: successfulTrades.toString(),
                contractTotalProfit: ethers.utils.formatUnits(totalProfit, 18),
                contractSuccessRate: successRate.toString() + '%',

                // Bot stats
                opportunitiesFound: this.stats.opportunitiesFound,
                tradesExecuted: this.stats.tradesExecuted,
                totalGasSpentBNB: gasSpentBNB,
                errors: this.stats.errors,

                // Balance
                usdtBalance: usdtBalanceFormatted,

                // Status
                isRunning: this.isRunning,
                uptime: this.getUptime()
            };
        } catch (error) {
            logger.error(`❌ Error getting stats: ${error.message}`);
            return null;
        }
    }

    getUptime() {
        if (!this.startTime) return '0s';
        const uptime = Date.now() - this.startTime;
        const hours = Math.floor(uptime / (1000 * 60 * 60));
        const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
        return `${hours}h ${minutes}m`;
    }

    async stop() {
        logger.info('🛑 Stopping bot...');
        this.isRunning = false;

        // Remove event listeners
        this.contract.removeAllListeners();

        logger.info('✅ Bot stopped');
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ArbitrageBot;