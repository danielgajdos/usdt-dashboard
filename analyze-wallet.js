// Wallet Transaction Analysis Script
const https = require('https');

const CONFIG = {
    ETHERSCAN_V2_API_URL: 'https://api.etherscan.io/v2/api',
    WALLET_ADDRESS: '0x1C34183e8D11Ad41c9D7a50856cf961dfae55862',
    API_KEY: 'UQZ2NTK6G26RIJTA34B9MIA74ZZ5BD8G7U'
};

async function fetchTransactions() {
    const url = `${CONFIG.ETHERSCAN_V2_API_URL}?chainid=56&module=account&action=tokentx&address=${CONFIG.WALLET_ADDRESS}&page=1&offset=1000&sort=asc&apikey=${CONFIG.API_KEY}`;
    
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.status === '1' && parsed.result) {
                        // Filter for USDT and stablecoin transactions
                        const filtered = parsed.result.filter(tx =>
                            tx.tokenSymbol && (
                                tx.tokenSymbol.toUpperCase().includes('USDT') ||
                                tx.tokenSymbol.toUpperCase().includes('USD') ||
                                tx.tokenSymbol.toUpperCase().includes('BUSD') ||
                                tx.tokenSymbol.toUpperCase().includes('USDC') ||
                                (tx.tokenName && (
                                    tx.tokenName.toUpperCase().includes('TETHER') ||
                                    tx.tokenName.toUpperCase().includes('USD COIN') ||
                                    tx.tokenName.toUpperCase().includes('BINANCE USD')
                                ))
                            )
                        );
                        resolve(filtered);
                    } else {
                        reject(new Error(parsed.message || 'No transactions found'));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

function analyzeTransactions(transactions) {
    console.log(`\n🔍 ANALYZING WALLET: ${CONFIG.WALLET_ADDRESS}`);
    console.log(`📊 Found ${transactions.length} USDT/stablecoin transactions\n`);
    
    if (transactions.length === 0) {
        console.log('❌ No transactions found for analysis');
        return;
    }
    
    // Sort by timestamp
    const sortedTxs = transactions.sort((a, b) => parseInt(a.timeStamp) - parseInt(b.timeStamp));
    
    // Analyze wallet patterns
    const walletStats = new Map();
    const userWallet = CONFIG.WALLET_ADDRESS.toLowerCase();
    
    sortedTxs.forEach((tx, index) => {
        const isReceived = tx.to.toLowerCase() === userWallet;
        const externalWallet = (isReceived ? tx.from : tx.to).toLowerCase();
        const amount = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal));
        const date = new Date(parseInt(tx.timeStamp) * 1000);
        
        if (!walletStats.has(externalWallet)) {
            walletStats.set(externalWallet, {
                inCount: 0,
                outCount: 0,
                totalIn: 0,
                totalOut: 0,
                firstSeen: date,
                lastSeen: date,
                transactions: []
            });
        }
        
        const stats = walletStats.get(externalWallet);
        
        if (isReceived) {
            stats.inCount++;
            stats.totalIn += amount;
        } else {
            stats.outCount++;
            stats.totalOut += amount;
        }
        
        stats.lastSeen = date;
        stats.transactions.push({
            index: index + 1,
            date: date.toISOString().split('T')[0],
            time: date.toTimeString().split(' ')[0],
            direction: isReceived ? 'IN' : 'OUT',
            amount: amount,
            hash: tx.hash.substring(0, 10) + '...'
        });
    });
    
    // Find first deposit wallet
    const firstTx = sortedTxs[0];
    const firstIsReceived = firstTx.to.toLowerCase() === userWallet;
    const firstWallet = firstIsReceived ? firstTx.from.toLowerCase() : firstTx.to.toLowerCase();
    
    console.log(`💰 FIRST TRANSACTION:`);
    console.log(`   Direction: ${firstIsReceived ? 'RECEIVED' : 'SENT'}`);
    console.log(`   Wallet: ${firstWallet}`);
    console.log(`   Amount: ${(parseFloat(firstTx.value) / Math.pow(10, parseInt(firstTx.tokenDecimal))).toFixed(2)} ${firstTx.tokenSymbol}`);
    console.log(`   Date: ${new Date(parseInt(firstTx.timeStamp) * 1000).toISOString()}`);
    
    console.log(`\n📋 WALLET ANALYSIS:`);
    console.log('='.repeat(80));
    
    // Sort wallets by first interaction
    const sortedWallets = Array.from(walletStats.entries())
        .sort(([,a], [,b]) => a.firstSeen - b.firstSeen);
    
    sortedWallets.forEach(([wallet, stats], index) => {
        const isFirstWallet = wallet === firstWallet;
        const totalTxs = stats.inCount + stats.outCount;
        const netFlow = stats.totalIn - stats.totalOut;
        
        console.log(`\n${index + 1}. ${wallet.substring(0, 10)}...${wallet.substring(wallet.length - 6)} ${isFirstWallet ? '👑 FIRST' : ''}`);
        console.log(`   Transactions: ${totalTxs} (${stats.inCount} in, ${stats.outCount} out)`);
        console.log(`   Volume: In $${stats.totalIn.toFixed(2)}, Out $${stats.totalOut.toFixed(2)}`);
        console.log(`   Net Flow: ${netFlow >= 0 ? '+' : ''}$${netFlow.toFixed(2)}`);
        console.log(`   Period: ${stats.firstSeen.toISOString().split('T')[0]} to ${stats.lastSeen.toISOString().split('T')[0]}`);
        
        // Suggest categorization
        let category = 'UNKNOWN';
        if (stats.inCount > 0 && stats.outCount > 0) {
            category = 'TRADING (bidirectional)';
        } else if (stats.inCount > 0 && stats.outCount === 0) {
            category = isFirstWallet ? 'INITIAL FUNDING' : 'DEPOSIT ONLY';
        } else if (stats.outCount > 0 && stats.inCount === 0) {
            category = 'WITHDRAWAL ONLY';
        }
        
        console.log(`   Suggested: ${category}`);
        
        // Show recent transactions
        if (stats.transactions.length <= 5) {
            console.log(`   Recent transactions:`);
            stats.transactions.forEach(tx => {
                console.log(`     ${tx.date} ${tx.time} ${tx.direction} $${tx.amount.toFixed(2)} (${tx.hash})`);
            });
        } else {
            console.log(`   First 3 transactions:`);
            stats.transactions.slice(0, 3).forEach(tx => {
                console.log(`     ${tx.date} ${tx.time} ${tx.direction} $${tx.amount.toFixed(2)} (${tx.hash})`);
            });
            console.log(`   Last 2 transactions:`);
            stats.transactions.slice(-2).forEach(tx => {
                console.log(`     ${tx.date} ${tx.time} ${tx.direction} $${tx.amount.toFixed(2)} (${tx.hash})`);
            });
        }
    });
    
    console.log(`\n🎯 RECOMMENDATIONS:`);
    console.log('='.repeat(50));
    console.log(`1. First wallet (${firstWallet.substring(0, 10)}...) should be categorized as INITIAL FUNDING`);
    console.log(`2. Wallets with both IN and OUT transactions are likely TRADING platforms`);
    console.log(`3. Wallets with only OUT transactions are likely WITHDRAWAL destinations`);
    console.log(`4. Wallets with only IN transactions (except first) might be additional DEPOSIT sources`);
}

// Run analysis
async function main() {
    try {
        const transactions = await fetchTransactions();
        analyzeTransactions(transactions);
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

main();