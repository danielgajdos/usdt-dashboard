#!/usr/bin/env node

require('dotenv').config();
const ArbitrageBot = require('./src/ArbitrageBot');
const Dashboard = require('./src/dashboard');
const winston = require('winston');
const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Configure main logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [MAIN]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'logs/main.log' })
    ]
});

// Validate environment variables
function validateConfig() {
    const required = [
        'PRIVATE_KEY',
        'ARBITRAGE_CONTRACT_ADDRESS',
        'BSC_TESTNET_RPC'
    ];

    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        logger.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
        logger.error('📝 Please copy .env.example to .env and fill in the required values');
        process.exit(1);
    }

    // Validate private key format
    // Validate private key format
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(process.env.PRIVATE_KEY)) {
        logger.error('❌ Invalid private key format. Should be 64 hex characters (0x prefix is optional)');
        process.exit(1);
    }

    logger.info('✅ Configuration validated');
}

// Create bot configuration
function createBotConfig() {
    const isProduction = process.env.NODE_ENV === 'production';

    return {
        network: isProduction ? 'mainnet' : 'testnet',
        rpcUrl: isProduction ? process.env.BSC_MAINNET_RPC : process.env.BSC_TESTNET_RPC,
        privateKey: process.env.PRIVATE_KEY,
        contractAddress: process.env.ARBITRAGE_CONTRACT_ADDRESS,

        // Trading parameters
        minProfitPercent: parseFloat(process.env.MIN_PROFIT_PERCENT) || 0.1,
        maxGasPriceGwei: parseInt(process.env.MAX_GAS_PRICE_GWEI) || 10,
        tradeAmountUSDT: parseInt(process.env.TRADE_AMOUNT_USDT) || 1000, // Start small on testnet
        monitoringIntervalMs: parseInt(process.env.MONITORING_INTERVAL_MS) || 5000,

        // Dashboard
        port: parseInt(process.env.PORT) || 3000
    };
}

async function main() {
    try {
        logger.info('🚀 Starting Arbitrage Bot System...');
        logger.info(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);

        // Validate configuration
        validateConfig();

        // Create bot configuration
        const config = createBotConfig();

        logger.info(`📍 Network: ${config.network}`);
        logger.info(`📍 Contract: ${config.contractAddress}`);
        logger.info(`💰 Trade Amount: $${config.tradeAmountUSDT} USDT`);
        logger.info(`⚡ Min Profit: ${config.minProfitPercent}%`);

        // Initialize bot
        const bot = new ArbitrageBot(config);

        // Initialize dashboard
        const dashboard = new Dashboard(bot);
        dashboard.start(config.port);

        // Handle graceful shutdown
        process.on('SIGINT', async () => {
            logger.info('🛑 Received SIGINT, shutting down gracefully...');

            try {
                await bot.stop();
                dashboard.stop();
                logger.info('✅ Shutdown complete');
                process.exit(0);
            } catch (error) {
                logger.error(`❌ Error during shutdown: ${error.message}`);
                process.exit(1);
            }
        });

        process.on('SIGTERM', async () => {
            logger.info('🛑 Received SIGTERM, shutting down gracefully...');

            try {
                await bot.stop();
                dashboard.stop();
                logger.info('✅ Shutdown complete');
                process.exit(0);
            } catch (error) {
                logger.error(`❌ Error during shutdown: ${error.message}`);
                process.exit(1);
            }
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            logger.error(`❌ Uncaught Exception: ${error.message}`);
            logger.error(error.stack);
            process.exit(1);
        });

        process.on('unhandledRejection', (reason, promise) => {
            logger.error(`❌ Unhandled Rejection at: ${promise}, reason: ${reason}`);
            process.exit(1);
        });

        // Auto-start bot if configured
        if (process.env.AUTO_START === 'true') {
            logger.info('🤖 Auto-starting bot...');
            setTimeout(async () => {
                try {
                    await bot.start();
                } catch (error) {
                    logger.error(`❌ Auto-start failed: ${error.message}`);
                }
            }, 5000); // Wait 5 seconds for everything to initialize
        }

        logger.info('✅ System initialized successfully');
        logger.info(`📊 Dashboard: http://localhost:${config.port}`);
        logger.info('🎯 Ready for arbitrage trading!');

    } catch (error) {
        logger.error(`❌ Failed to start system: ${error.message}`);
        process.exit(1);
    }
}

// Start the application
main();