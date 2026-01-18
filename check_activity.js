const { ethers } = require('ethers');
const config = require('./config');

async function checkActivity() {
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    const wallets = config.TARGET_WALLETS;

    console.log(`Checking activity for ${wallets.length} wallets...`);
    const blockNumber = await provider.getBlockNumber();
    console.log(`Current Block: ${blockNumber}`);

    for (const wallet of wallets) {
        console.log(`\nChecking Wallet: ${wallet}`);
        let txCount = await provider.getTransactionCount(wallet);
        console.log(`  Total Tx Count: ${txCount}`);

        // Note: Standard RPCs don't easily let you fetch "last tx" efficiently without scanning or an indexer.
        // We will just check balance as a proxy for "alive" and maybe scan last 100 blocks?
        // Etherscan API is better for this but we don't have a key configured.
        // We'll trust the Tx Count > 0 means it exists.

        const balance = await provider.getBalance(wallet);
        console.log(`  Balance: ${ethers.formatEther(balance)} BNB`);
    }
}

checkActivity();
