const https = require('https');

// API Configuration
const API_CONFIG = {
  ETHERSCAN_API_URL: 'https://api.etherscan.io/api',
  ETHERSCAN_V2_API_URL: 'https://api.etherscan.io/v2/api',
  BSCSCAN_API_URL: 'https://api.bscscan.com/api',
  BSCSCAN_V2_API_URL: 'https://api.bscscan.com/v2/api',
  API_KEY: 'UQZ2NTK6G26RIJTA34B9MIA74ZZ5BD8G7U'
};

// Replace with your actual wallet addresses
const WALLET_ADDRESSES = {
  ethereum: '0xe74a5C39231e2C065fA53dE164E31548cAA45078', // Your ETH address
  bsc: '0xe74a5C39231e2C065fA53dE164E31548cAA45078', // Your BSC address
  bitcoin: '' // Add BTC address if needed
};

// Make API request
function makeRequest(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (res.statusCode === 200) {
            resolve(response);
          } else {
            reject(new Error(`API Error: ${response.message || data}`));
          }
        } catch (error) {
          reject(new Error(`Parse Error: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.end();
  });
}

// Get Ethereum transactions (including ERC-20 tokens)
async function getEthereumTransactions(address) {
  try {
    console.log('\n=== ETHEREUM TRANSACTIONS ===');

    // Get ETH transactions using configured API URL
    const ethUrl = `${API_CONFIG.ETHERSCAN_API_URL}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${API_CONFIG.API_KEY}`;
    const ethResponse = await makeRequest(ethUrl);

    console.log(`Found ${ethResponse.result ? ethResponse.result.length : 0} ETH transactions`);

    if (ethResponse.result && Array.isArray(ethResponse.result) && ethResponse.result.length > 0) {
      ethResponse.result.slice(0, 10).forEach(tx => {
        if (tx.to.toLowerCase() === address.toLowerCase() && tx.value !== '0') {
          console.log(`Token: ETH`);
          console.log(`Amount Received: ${(parseInt(tx.value) / 1e18).toFixed(6)} ETH`);
          console.log(`From: ${tx.from}`);
          console.log(`TxHash: ${tx.hash}`);
          console.log(`Block: ${tx.blockNumber}`);
          console.log(`Time: ${new Date(parseInt(tx.timeStamp) * 1000)}`);
          console.log('-----------------------------');
        }
      });
    }

    // Get ERC-20 token transactions (focusing on USDT)
    const tokenUrl = `${API_CONFIG.ETHERSCAN_API_URL}?module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${API_CONFIG.API_KEY}`;
    const tokenResponse = await makeRequest(tokenUrl);

    console.log(`Found ${tokenResponse.result ? tokenResponse.result.length : 0} ERC-20 token transactions`);

    if (tokenResponse.result && Array.isArray(tokenResponse.result) && tokenResponse.result.length > 0) {
      // Filter for USDT transactions specifically
      const usdtTransactions = tokenResponse.result.filter(tx =>
        tx.tokenSymbol && tx.tokenSymbol.toUpperCase().includes('USDT')
      );

      console.log(`Found ${usdtTransactions.length} USDT transactions on Ethereum`);

      usdtTransactions.slice(0, 20).forEach(tx => {
        const isReceived = tx.to.toLowerCase() === address.toLowerCase();
        const isSent = tx.from.toLowerCase() === address.toLowerCase();
        const amount = (parseInt(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal))).toFixed(2);

        if (isReceived || isSent) {
          console.log(`Token: ${tx.tokenSymbol} (Ethereum)`);
          console.log(`Type: ${isReceived ? 'RECEIVED' : 'SENT'}`);
          console.log(`Amount: ${amount} ${tx.tokenSymbol}`);
          console.log(`${isReceived ? 'From' : 'To'}: ${isReceived ? tx.from : tx.to}`);
          console.log(`TxHash: ${tx.hash}`);
          console.log(`Block: ${tx.blockNumber}`);
          console.log(`Time: ${new Date(parseInt(tx.timeStamp) * 1000)}`);
          console.log(`Contract: ${tx.contractAddress}`);
          console.log('-----------------------------');
        }
      });
    }
  } catch (error) {
    console.error('Error fetching Ethereum transactions:', error.message);
  }
}

// Calculate daily balance changes and percentage increases
function calculateDailyGrowth(transactions, address) {
  console.log('\n=== DAILY GROWTH ANALYSIS ===');

  // Sort transactions by timestamp (oldest first)
  const sortedTxs = transactions.sort((a, b) => parseInt(a.timeStamp) - parseInt(b.timeStamp));

  // Track daily received amounts (focus on growth from received transactions)
  const dailyReceived = new Map();
  const dailyBalances = new Map();
  let totalReceived = 0;
  let runningBalance = 0;

  console.log('📊 TRANSACTION ANALYSIS:');
  console.log('Processing transactions chronologically...\n');

  // Process each transaction
  sortedTxs.forEach((tx, index) => {
    const isReceived = tx.to.toLowerCase() === address.toLowerCase();
    const amount = parseFloat(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal));
    const date = new Date(parseInt(tx.timeStamp) * 1000);
    const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD format

    // Update running balance
    if (isReceived) {
      runningBalance += amount;
      totalReceived += amount;
    } else {
      runningBalance -= amount;
    }

    // Track daily received amounts
    if (isReceived) {
      if (!dailyReceived.has(dateKey)) {
        dailyReceived.set(dateKey, 0);
      }
      dailyReceived.set(dateKey, dailyReceived.get(dateKey) + amount);
    }

    // Store daily balance (keep the latest balance for each day)
    dailyBalances.set(dateKey, {
      balance: runningBalance,
      date: date,
      lastTxAmount: amount,
      lastTxType: isReceived ? 'RECEIVED' : 'SENT',
      dailyReceived: dailyReceived.get(dateKey) || 0
    });

    // Show first few transactions for debugging
    if (index < 5) {
      console.log(`${date.toLocaleDateString()}: ${isReceived ? 'RECEIVED' : 'SENT'} $${amount.toFixed(2)} - Balance: $${runningBalance.toFixed(2)}`);
    }
  });

  // Convert to array and sort by date
  const dailyData = Array.from(dailyBalances.entries())
    .map(([dateKey, data]) => ({ dateKey, ...data }))
    .sort((a, b) => new Date(a.dateKey) - new Date(b.dateKey));

  if (dailyData.length === 0) {
    console.log('No transaction data available for analysis');
    return { dailyData: [], startBalance: 0, endBalance: 0 };
  }

  // Find the first significant balance (when you started with meaningful amount)
  let startingIndex = 0;
  let startingBalance = 0;

  // Look for the first day with a significant received amount (> $100)
  for (let i = 0; i < dailyData.length; i++) {
    if (dailyData[i].dailyReceived > 100) {
      startingIndex = i;
      startingBalance = dailyData[i].dailyReceived; // Use the first significant deposit as starting point
      break;
    }
  }

  // If no significant starting point found, use the first received amount
  if (startingBalance === 0) {
    for (let i = 0; i < dailyData.length; i++) {
      if (dailyData[i].dailyReceived > 0) {
        startingIndex = i;
        startingBalance = dailyData[i].dailyReceived;
        break;
      }
    }
  }

  console.log('\n📈 DAILY BALANCE PROGRESSION:');
  console.log('='.repeat(60));

  // Calculate growth from the starting point
  let previousValue = startingBalance;

  for (let i = startingIndex; i < dailyData.length; i++) {
    const current = dailyData[i];
    const dateFormatted = new Date(current.dateKey).toLocaleDateString('en-GB');

    if (i === startingIndex) {
      console.log(`${dateFormatted}: Starting with $${startingBalance.toFixed(2)} (first significant deposit)`);
      previousValue = startingBalance;
    } else {
      // For growth calculation, use the highest received amount as the "value"
      const currentValue = current.dailyReceived > 0 ? current.dailyReceived : previousValue;

      if (current.dailyReceived > 0) {
        const change = currentValue - previousValue;
        const percentChange = previousValue > 0 ? ((change / previousValue) * 100) : 0;
        const sign = change >= 0 ? '+' : '';

        console.log(`${dateFormatted}: $${previousValue.toFixed(2)} → $${currentValue.toFixed(2)} ${sign}${percentChange.toFixed(2)}%`);
        previousValue = currentValue;
      }
    }
  }

  // Calculate overall growth using the progression of received amounts
  const endValue = previousValue;
  const totalChange = endValue - startingBalance;
  const totalPercentChange = startingBalance > 0 ? ((totalChange / startingBalance) * 100) : 0;

  console.log('='.repeat(60));
  console.log('🎯 OVERALL PERFORMANCE SUMMARY:');
  console.log(`Starting Amount: $${startingBalance.toFixed(2)}`);
  console.log(`Latest Amount: $${endValue.toFixed(2)}`);
  console.log(`Total Growth: ${totalChange >= 0 ? '+' : ''}$${totalChange.toFixed(2)}`);
  console.log(`Overall Growth: ${totalPercentChange >= 0 ? '+' : ''}${totalPercentChange.toFixed(2)}%`);

  // Additional statistics
  const tradingDays = dailyData.length - startingIndex;
  const avgDailyChange = totalChange / tradingDays;
  const avgDailyPercent = totalPercentChange / tradingDays;

  console.log(`\n📊 STATISTICS:`);
  console.log(`Total Received: $${totalReceived.toFixed(2)}`);
  console.log(`Active Days: ${tradingDays}`);
  console.log(`Average Daily Change: ${avgDailyChange >= 0 ? '+' : ''}$${avgDailyChange.toFixed(2)}`);
  console.log(`Average Daily Growth: ${avgDailyPercent >= 0 ? '+' : ''}${avgDailyPercent.toFixed(2)}%`);

  return { dailyData, startBalance: startingBalance, endBalance: endValue, totalPercentChange, avgDailyPercent };
}

// Calculate business days between two dates
function getBusinessDays(startDate, endDate) {
  let count = 0;
  const current = new Date(startDate);

  while (current <= endDate) {
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Not Sunday (0) or Saturday (6)
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
}

// Predict end-of-year balance based on current trend (business days only)
function predictEndOfYearBalance(currentBalance, avgDailyGrowth, startDate, endDate) {
  console.log('\n=== 🔮 END OF YEAR PREDICTION (BUSINESS DAYS ONLY) ===');
  console.log('='.repeat(70));

  const today = new Date();
  const endOfYear = new Date(today.getFullYear(), 11, 31); // December 31st
  const totalDaysUntilEndOfYear = Math.ceil((endOfYear - today) / (1000 * 60 * 60 * 24));
  const businessDaysUntilEndOfYear = getBusinessDays(today, endOfYear);

  console.log(`📅 Current Date: ${today.toLocaleDateString('en-GB')} (${today.toLocaleDateString('en-US', { weekday: 'long' })})`);
  console.log(`📅 End of Year: ${endOfYear.toLocaleDateString('en-GB')}`);
  console.log(`📅 Total Days Remaining: ${totalDaysUntilEndOfYear} days`);
  console.log(`📈 Business Days Remaining: ${businessDaysUntilEndOfYear} trading days`);
  console.log(`⏰ Trading Schedule: Monday-Friday only (weekends excluded)`);

  // Calculate different prediction scenarios
  const scenarios = [
    {
      name: 'Conservative (50% of current trend)',
      multiplier: 0.5,
      description: 'Assuming growth slows down significantly'
    },
    {
      name: 'Current Trend',
      multiplier: 1.0,
      description: 'Maintaining current average daily growth'
    },
    {
      name: 'Optimistic (75% of current trend)',
      multiplier: 0.75,
      description: 'Slight slowdown but still strong growth'
    },
    {
      name: 'Aggressive (Current trend continues)',
      multiplier: 1.0,
      description: 'Full current trend maintained'
    }
  ];

  console.log(`\n💰 Current Balance: $${currentBalance.toFixed(2)}`);
  console.log(`📈 Average Daily Growth: ${avgDailyGrowth.toFixed(2)}% (per trading day)`);
  console.log('\n🎯 PREDICTION SCENARIOS (Business Days Only):');
  console.log('='.repeat(70));

  scenarios.forEach((scenario, index) => {
    if (index === 3) return; // Skip duplicate aggressive scenario

    const adjustedDailyGrowth = avgDailyGrowth * scenario.multiplier;
    const dailyMultiplier = 1 + (adjustedDailyGrowth / 100);

    // Compound growth calculation
    const predictedBalance = currentBalance * Math.pow(dailyMultiplier, businessDaysUntilEndOfYear);
    const totalGrowth = predictedBalance - currentBalance;
    const totalGrowthPercent = (totalGrowth / currentBalance) * 100;

    console.log(`\n${index + 1}. ${scenario.name}:`);
    console.log(`   ${scenario.description}`);
    console.log(`   Daily Growth: ${adjustedDailyGrowth.toFixed(2)}%`);
    console.log(`   Predicted Balance: $${predictedBalance.toFixed(2)}`);
    console.log(`   Total Growth: +$${totalGrowth.toFixed(2)} (+${totalGrowthPercent.toFixed(1)}%)`);
  });

  // Calculate monthly milestones
  console.log('\n📊 MONTHLY MILESTONES (Current Trend):');
  console.log('='.repeat(60));

  const dailyMultiplier = 1 + (avgDailyGrowth / 100);
  let projectedBalance = currentBalance;
  const currentMonth = today.getMonth();
  const currentYear = today.getFullYear();

  for (let month = currentMonth; month <= 11; month++) {
    const monthDate = new Date(currentYear, month + 1, 0); // Last day of month
    const daysToMonth = Math.ceil((monthDate - today) / (1000 * 60 * 60 * 24));

    if (daysToMonth > 0) {
      const monthBalance = currentBalance * Math.pow(dailyMultiplier, daysToMonth);
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      console.log(`${monthNames[month]} ${currentYear}: $${monthBalance.toFixed(2)} (in ${daysToMonth} days)`);
    }
  }

  // Risk assessment
  console.log('\n⚠️  RISK ASSESSMENT:');
  console.log('='.repeat(60));
  console.log('• Market volatility could significantly impact predictions');
  console.log('• Regulatory changes may affect trading opportunities');
  console.log('• Past performance does not guarantee future results');
  console.log('• Consider diversification and risk management strategies');

  // Best case scenario using business days
  const finalDailyMultiplier = 1 + (avgDailyGrowth / 100);
  const bestCaseBalance = currentBalance * Math.pow(finalDailyMultiplier, businessDaysUntilEndOfYear);
  const worstCaseBalance = currentBalance * Math.pow(1 + (avgDailyGrowth * 0.2 / 100), businessDaysUntilEndOfYear);

  console.log('\n🎯 SUMMARY:');
  console.log('='.repeat(60));
  console.log(`Best Case (Current Trend): $${bestCaseBalance.toFixed(2)}`);
  console.log(`Conservative Estimate: $${worstCaseBalance.toFixed(2)}`);
  console.log(`Range: $${worstCaseBalance.toFixed(2)} - $${bestCaseBalance.toFixed(2)}`);

  const multiplier = bestCaseBalance / currentBalance;
  console.log(`\n🚀 If current trend continues, your balance could grow ${multiplier.toFixed(1)}x by end of year!`);

  return {
    currentBalance,
    predictedBalance: bestCaseBalance,
    conservativeBalance: worstCaseBalance,
    daysRemaining: businessDaysUntilEndOfYear,
    totalGrowthPercent: ((bestCaseBalance - currentBalance) / currentBalance) * 100
  };
}

// Get BSC transactions using your BSCScan API key
async function getBSCTransactions(address) {
  try {
    console.log('\n=== BSC TRANSACTIONS ===');

    console.log('Using BSCScan API with Etherscan format...');

    try {
      // Try using the actual Etherscan V2 API endpoint for BSC
      let bnbResponse;

      try {
        // Use the etherscan.io v2 API with BSC chain ID
        const bnbUrlEtherscanV2 = `${API_CONFIG.ETHERSCAN_V2_API_URL}?chainid=56&module=account&action=txlist&address=${address}&page=1&offset=100&sort=desc&apikey=${API_CONFIG.API_KEY}`;
        bnbResponse = await makeRequest(bnbUrlEtherscanV2);
        console.log('Using etherscan.io V2 API for BSC');
      } catch (etherscanError) {
        console.log('Etherscan V2 failed, trying BSCScan V2...');

        // Fallback to BSCScan V2
        const bnbUrlBSC = `${API_CONFIG.BSCSCAN_V2_API_URL}?chainid=56&module=account&action=txlist&address=${address}&page=1&offset=100&sort=desc&apikey=${API_CONFIG.API_KEY}`;
        bnbResponse = await makeRequest(bnbUrlBSC);
        console.log('Using BSCScan V2 API');
      }

      console.log(`BNB transactions - Status: ${bnbResponse.status}, Message: ${bnbResponse.message}`);

      if (bnbResponse.status === '1' && bnbResponse.result && Array.isArray(bnbResponse.result)) {
        console.log(`Found ${bnbResponse.result.length} BNB transactions`);

        // Show BNB transactions
        let bnbCount = 0;
        bnbResponse.result.forEach(tx => {
          const isReceived = tx.to.toLowerCase() === address.toLowerCase();
          const isSent = tx.from.toLowerCase() === address.toLowerCase();
          const amount = (parseInt(tx.value) / 1e18).toFixed(6);

          if ((isReceived || isSent) && parseFloat(amount) > 0 && bnbCount < 10) {
            console.log(`\nToken: BNB`);
            console.log(`Type: ${isReceived ? 'RECEIVED' : 'SENT'}`);
            console.log(`Amount: ${amount} BNB`);
            console.log(`${isReceived ? 'From' : 'To'}: ${isReceived ? tx.from : tx.to}`);
            console.log(`TxHash: ${tx.hash}`);
            console.log(`Time: ${new Date(parseInt(tx.timeStamp) * 1000)}`);
            console.log('-----------------------------');
            bnbCount++;
          }
        });
      }

      // Get BEP-20 token transactions using Etherscan V2 API format
      let tokenResponse;

      try {
        // Try etherscan.io V2 API for BSC tokens - get more transactions for analysis
        const tokenUrlEtherscanV2 = `${API_CONFIG.ETHERSCAN_V2_API_URL}?chainid=56&module=account&action=tokentx&address=${address}&page=1&offset=1000&sort=desc&apikey=${API_CONFIG.API_KEY}`;
        tokenResponse = await makeRequest(tokenUrlEtherscanV2);
        console.log('Using etherscan.io V2 API for BEP-20 tokens');
      } catch (etherscanError) {
        console.log('Etherscan V2 tokens failed, trying BSCScan V2...');

        // Fallback to BSCScan V2
        const tokenUrlBSC = `${API_CONFIG.BSCSCAN_V2_API_URL}?chainid=56&module=account&action=tokentx&address=${address}&page=1&offset=1000&sort=desc&apikey=${API_CONFIG.API_KEY}`;
        tokenResponse = await makeRequest(tokenUrlBSC);
        console.log('Using BSCScan V2 API for tokens');
      }

      console.log(`\nBEP-20 tokens - Status: ${tokenResponse.status}, Message: ${tokenResponse.message}`);

      if (tokenResponse.status === '1' && tokenResponse.result && Array.isArray(tokenResponse.result)) {
        console.log(`Found ${tokenResponse.result.length} BEP-20 token transactions`);

        // Show unique tokens
        const uniqueTokens = [...new Set(tokenResponse.result.map(tx => tx.tokenSymbol))];
        console.log(`Token types: ${uniqueTokens.slice(0, 10).join(', ')}${uniqueTokens.length > 10 ? '...' : ''}`);

        // Filter and show USDT transactions
        const usdtTransactions = tokenResponse.result.filter(tx =>
          tx.tokenSymbol && (
            tx.tokenSymbol.toUpperCase().includes('USDT') ||
            tx.tokenSymbol.toUpperCase().includes('USD') ||
            tx.tokenName && tx.tokenName.toUpperCase().includes('TETHER')
          )
        );

        if (usdtTransactions.length > 0) {
          console.log(`\n--- USDT/USD TRANSACTIONS (${usdtTransactions.length} found) ---`);

          // Show recent transactions
          usdtTransactions.slice(0, 10).forEach(tx => {
            const isReceived = tx.to.toLowerCase() === address.toLowerCase();
            const isSent = tx.from.toLowerCase() === address.toLowerCase();
            const amount = (parseInt(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal))).toFixed(2);

            if (isReceived || isSent) {
              console.log(`\nToken: ${tx.tokenSymbol} (${tx.tokenName || 'Unknown'})`);
              console.log(`Type: ${isReceived ? 'RECEIVED' : 'SENT'}`);
              console.log(`Amount: ${amount} ${tx.tokenSymbol}`);
              console.log(`${isReceived ? 'From' : 'To'}: ${isReceived ? tx.from : tx.to}`);
              console.log(`TxHash: ${tx.hash}`);
              console.log(`Time: ${new Date(parseInt(tx.timeStamp) * 1000)}`);
              console.log(`Contract: ${tx.contractAddress}`);
              console.log('-----------------------------');
            }
          });

          // Calculate daily growth analysis
          const growthData = calculateDailyGrowth(usdtTransactions, address);

          // Predict end of year balance
          if (growthData.endBalance > 0 && growthData.avgDailyPercent > 0) {
            const sortedTxs = usdtTransactions.sort((a, b) => parseInt(a.timeStamp) - parseInt(b.timeStamp));
            predictEndOfYearBalance(
              growthData.endBalance,
              growthData.avgDailyPercent,
              new Date(sortedTxs[0].timeStamp * 1000),
              new Date()
            );
          }

        } else {
          console.log('\nNo USDT transactions found. Showing recent token transactions:');

          // Show recent token transactions
          tokenResponse.result.slice(0, 5).forEach(tx => {
            const isReceived = tx.to.toLowerCase() === address.toLowerCase();
            const isSent = tx.from.toLowerCase() === address.toLowerCase();
            const amount = (parseInt(tx.value) / Math.pow(10, parseInt(tx.tokenDecimal))).toFixed(6);

            if (isReceived || isSent) {
              console.log(`\nToken: ${tx.tokenSymbol} (${tx.tokenName || 'Unknown'})`);
              console.log(`Type: ${isReceived ? 'RECEIVED' : 'SENT'}`);
              console.log(`Amount: ${amount} ${tx.tokenSymbol}`);
              console.log(`Time: ${new Date(parseInt(tx.timeStamp) * 1000)}`);
              console.log('-----------------------------');
            }
          });
        }
      } else {
        console.log('BSC token API returned error or no data');
        console.log('Response:', JSON.stringify(tokenResponse, null, 2));
      }

    } catch (apiError) {
      console.log('BSC API error:', apiError.message);
      console.log('\n📍 Manual check options:');
      console.log(`🔗 All transactions: https://bscscan.com/address/${address}`);
      console.log(`🔗 Token transfers: https://bscscan.com/address/${address}#tokentxns`);
    }

  } catch (error) {
    console.error('Error fetching BSC transactions:', error.message);
  }
}

// Main function to get wallet transactions
async function getWalletTransactions() {
  console.log(`Fetching USDT transactions for wallet: ${WALLET_ADDRESSES.bsc}\n`);

  // Check BSC for USDT (BEP-20)
  if (WALLET_ADDRESSES.bsc) {
    await getBSCTransactions(WALLET_ADDRESSES.bsc);
  }

  // Check Ethereum for USDT (ERC-20)
  if (WALLET_ADDRESSES.ethereum) {
    await getEthereumTransactions(WALLET_ADDRESSES.ethereum);
  }

  console.log('\nUSDT transaction history fetched successfully!');
}

// Execute the function
getWalletTransactions();
