# USDT Trading Dashboard

A modern, responsive dashboard for tracking USDT trading performance with real-time data and year-end predictions.

## 🚀 Features

- **Real-time Data**: Fetches live USDT transactions from BSCScan API
- **Growth Analysis**: Daily performance tracking with percentage calculations
- **Predictions**: Conservative, current trend, and optimistic year-end projections
- **Interactive Charts**: Balance growth over time with trend predictions
- **Mobile Responsive**: Optimized for all screen sizes
- **Modern UI**: Dark theme with glassmorphism effects

## 📊 Dashboard Sections

### Current Performance
- Current balance and starting amount
- Total growth in dollars and percentage
- Real-time performance metrics

### Trading Statistics
- Active trading days
- Average daily growth rate
- Total volume processed
- Best performing day

### Year-End Predictions
- Business days remaining calculation
- Three prediction scenarios (Conservative, Current Trend, Optimistic)
- Interactive prediction cards

### Interactive Charts
- **Balance Growth Chart**: Historical data + future projections
- **Daily Growth Chart**: Bar chart showing daily percentage changes

## 🛠 Technical Details

- **API**: BSCScan Etherscan V2 API
- **Charts**: Chart.js for interactive visualizations
- **Responsive**: Mobile-first design with clamp() CSS functions
- **Performance**: Auto-refresh every 5 minutes
- **Browser Support**: Modern browsers with ES6+ support

## 🔧 Configuration

Update the `CONFIG` object in the HTML file:

```javascript
const CONFIG = {
    ETHERSCAN_V2_API_URL: 'https://api.etherscan.io/v2/api',
    WALLET_ADDRESS: 'YOUR_WALLET_ADDRESS',
    API_KEY: 'YOUR_API_KEY'
};
```

## 📱 Mobile Features

- Touch-friendly interface
- Responsive charts that adapt to screen size
- Optimized typography and spacing
- Horizontal layout for prediction cards on mobile
- Landscape mode support

## 🚀 Deployment

### GitHub Pages
1. Fork this repository
2. Enable GitHub Pages in repository settings
3. Access your dashboard at: `https://yourusername.github.io/usdt-dashboard`

### Netlify
1. Connect your GitHub repository
2. Deploy automatically on every commit
3. Custom domain support available

### Local Development
Simply open `usdt-dashboard.html` in your browser - no build process required!

## 🔒 Security Notes

- API keys are visible in client-side code
- Consider using environment variables for production
- BSCScan API has rate limits - get a proper API key for best performance

## 📈 Performance Metrics

Based on your current trading performance:
- **Starting Balance**: $2,317.07
- **Current Balance**: $3,547.32
- **Growth**: +53.09% over 18 days
- **Average Daily Growth**: +2.95%

## 🎯 Predictions

With current trend continuing over 73 business days:
- **Conservative**: $10,329 (+191%)
- **Current Trend**: $29,617 (+735%)
- **Optimistic**: $17,524 (+394%)

---

**Last Updated**: Auto-updates every 5 minutes
**Version**: 1.0.0
**License**: MIT