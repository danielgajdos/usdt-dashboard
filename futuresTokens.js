// Binance Futures shadow-venue universe.
//
// These are the tokens that backtested with positive MOMENTUM edge but have
// NO PancakeSwap BSC liquidity — unreachable by the DEX bot. The Futures venue
// (paper/shadow mode) trades them so we can see the edge we're currently
// leaving on the table.  Plus SOL as an overlap control (it trades on both
// venues, so we can compare DEX vs Futures execution on the same signal).
//
// Each gets a synthetic address (not a real contract — purely a key for
// marketData's per-token buffers). Price comes from Binance klines.
//
// Backtest edge (180d, perp cost + real funding, €100/trade, from research):
//   IO    +€136   DYDX  +€23   TAO  +€22
//   APT   +€23    PENGU +€30   (SOL +€16 overlap control)

const FUTURES_TOKENS = [
    { symbol: 'IO',    binanceSymbol: 'IOUSDT',    decimals: 18, address: '0xF0000000000000000000000000000000000000I0' },
    { symbol: 'PENGU', binanceSymbol: 'PENGUUSDT', decimals: 18, address: '0xF000000000000000000000000000000000PENGU' },
    { symbol: 'DYDX',  binanceSymbol: 'DYDXUSDT',  decimals: 18, address: '0xF0000000000000000000000000000000000DYDX' },
    { symbol: 'TAO',   binanceSymbol: 'TAOUSDT',   decimals: 18, address: '0xF00000000000000000000000000000000000TAO' },
    { symbol: 'APT',   binanceSymbol: 'APTUSDT',   decimals: 18, address: '0xF00000000000000000000000000000000000APT' },
    // overlap control — also trades on the DEX bot; lets us compare venues
    { symbol: 'SOLf',  binanceSymbol: 'SOLUSDT',   decimals: 18, address: '0xF00000000000000000000000000000000000SOL' }
];

module.exports = { FUTURES_TOKENS };
