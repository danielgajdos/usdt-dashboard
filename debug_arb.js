const { ethers } = require('ethers');
const config = require('./config');

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)'
];

async function runDebug() {
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    const router = new ethers.Contract(config.ROUTER_ADDRESS, ROUTER_ABI, provider);

    const path = [
        config.TOKENS.WBNB,
        config.TOKENS.BUSD,
        config.TOKENS.USDT, // Check if this address is correct for BSC Mainnet
        config.TOKENS.WBNB
    ];

    const amountIn = ethers.parseEther(config.INVESTMENT_AMOUNT);

    console.log(`Checking Path: ${path.join(' -> ')}`);
    console.log(`Input Amount: ${ethers.formatEther(amountIn)} WBNB`);

    try {
        const amounts = await router.getAmountsOut(amountIn, path);
        const amountOut = amounts[amounts.length - 1];
        const profit = amountOut - amountIn;
        const profitEth = ethers.formatEther(profit);

        console.log(`Output Amount: ${ethers.formatEther(amountOut)} WBNB`);
        console.log(`Profit (BNB): ${profitEth}`);
        console.log(`Profit (%): ${((parseFloat(profitEth) / parseFloat(config.INVESTMENT_AMOUNT)) * 100).toFixed(4)}%`);
        console.log(`Threshold used: -0.0005`);
        console.log(`Would trigger? ${parseFloat(profitEth) > -0.0005}`);

    } catch (error) {
        console.error("Error:", error.message);
    }
}

runDebug();
