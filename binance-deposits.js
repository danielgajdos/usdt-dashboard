const crypto = require('crypto');
const https = require('https');

const API_KEY = '2nGRWCx4C6QQbSOpG5c3ppfMKZVjHowks3q1bDbBnaLHiyFUc1wJ0NafO0nSnrWP';
const API_SECRET = 'SQli6gRO3c3Vzllojg3ExlVEZ1fDdD7MUU51lJIkjAmD0QHNNrGtLWdAlbo6vZxd';

// Create signature for authenticated requests
function createSignature(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

// Make authenticated API request
function makeRequest(endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const queryString = new URLSearchParams({
      ...params,
      timestamp: timestamp
    }).toString();
    
    const signature = createSignature(queryString, API_SECRET);
    const finalQuery = `${queryString}&signature=${signature}`;
    
    const options = {
      hostname: 'api.binance.com',
      path: `${endpoint}?${finalQuery}`,
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': API_KEY,
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
            reject(new Error(`API Error: ${response.msg || data}`));
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

// Fetch deposit history
async function getDepositHistory() {
  try {
    const response = await makeRequest('/sapi/v1/capital/deposit/hisrec');
    
    if (response && response.length > 0) {
      response.forEach(tx => {
        console.log(`Coin: ${tx.coin}`);
        console.log(`Amount Received: ${tx.amount}`);
        console.log(`Address: ${tx.address || 'N/A'}`);
        console.log(`TxID: ${tx.txId || 'N/A'}`);
        console.log(`Status: ${tx.status === 1 ? 'Success' : 'Pending/Failed'}`);
        console.log(`Deposit Time: ${new Date(tx.insertTime)}`);
        console.log('-----------------------------');
      });
    } else {
      console.log('No deposit history found');
    }
  } catch (error) {
    console.error('Error fetching deposit history:', error.message);
  }
}

// Execute the function
getDepositHistory();