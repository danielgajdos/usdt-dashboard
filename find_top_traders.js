const { ethers } = require('ethers');
const config = require('./config');
const chalk = require('chalk');

// Connect to RPC
const provider = new ethers.JsonRpcProvider(config.RPC_URL);

async function findTopTraders() {
    console.log(chalk.blue('Starting Smart Money Analysis...'));

    const currentBlock = await provider.getBlockNumber();
    const startBlock = currentBlock - 200; // Look back 200 blocks (~10 mins) for speed

    console.log(`Scanning blocks ${startBlock} to ${currentBlock}...`);

    const traders = {};

    for (let i = startBlock; i <= currentBlock; i++) {
        if (i % 10 === 0) process.stdout.write('.');

        try {
            const block = await provider.getBlock(i, true);
            if (!block || !block.prefetchedTransactions) continue;

            for (const tx of block.prefetchedTransactions) {
                // Look for interactions with Router (Swaps)
                if (tx.to && tx.to.toLowerCase() === config.ROUTER_ADDRESS.toLowerCase()) {
                    const from = tx.from;
                    if (!traders[from]) traders[from] = { count: 0, hashes: [] };
                    traders[from].count++;
                    traders[from].hashes.push(tx.hash);
                }
            }
        } catch (e) {
            // ignore
        }
    }

    console.log('\nAnalysis Complete.');

    // Sort by activity
    const sortedTraders = Object.entries(traders)
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10); // Top 10

    console.log(chalk.green('\nTop 10 Active Traders (Last 10 mins):'));
    sortedTraders.forEach(([address, data], index) => {
        console.log(`${index + 1}. ${address} - ${data.count} Swaps`);
        console.log(`   Sample TX: https://bscscan.com/tx/${data.hashes[0]}`);
    });
}

findTopTraders();
