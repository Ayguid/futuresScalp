# Binance Futures Scalping Bot 🤖

A high-frequency scalping bot for Binance Futures that uses advanced technical analysis and multi-confirmation strategy for automated trading.

## 🚀 Features

- **Advanced Scalping Strategy** - EMA, RSI, MACD, Volume, and Momentum confirmations
- **Multi-Timeframe Support** - Optimized for 1-minute scalping
- **Risk Management** - Stop loss, take profit, trailing stops, and daily loss limits
- **Multi-Symbol Trading** - Trade multiple pairs simultaneously (BTCUSDT, ETHUSDT, DOGEUSDT)
- **Backtesting Engine** - Historical data testing with detailed analytics
- **Real-time Monitoring** - Live position tracking and performance metrics
- **Isolated/Cross Margin** - Configurable margin modes
- **Leverage Management** - Automated leverage setting

## 📊 Strategy Details

The bot uses a multi-indicator confirmation system:

- **EMA Crossovers** (3/8 periods)
- **RSI Momentum** (10 period, 25-75 thresholds)
- **MACD Signals** (8,21,5 settings)
- **Volume Confirmation** (80% above average)
- **Price Momentum** (0.05% threshold)
- **Time-based Exits** (5-minute maximum hold)

## 🛠 Installation

### 1. Clone the repository

```bash
git clone <your-repo-url>
cd binance-scalping-bot
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your Binance API keys.

### 4. Set up configuration

Edit `config.js` to match your trading preferences.

## ⚙️ Configuration

### Environment Variables (.env)

```env
BOT_ENVIRONMENT=testnet
BINANCE_TESTNET_API_KEY=your_testnet_api_key
BINANCE_TESTNET_SECRET_KEY=your_testnet_secret_key
BINANCE_MAINNET_API_KEY=your_mainnet_api_key
BINANCE_MAINNET_SECRET_KEY=your_mainnet_secret_key
```

### Trading Configuration (config.js)

```javascript
{
    environment: 'testnet', // or 'mainnet'
    trading: {
        symbols: ['BTCUSDT', 'ETHUSDT', 'DOGEUSDT'],
        leverage: 10,
        maxPositionSize: 200,
        maxOpenPositions: 4,
        positionPercent: 1,
        marginMode: 'ISOLATED'
    },
    risk: {
        maxDailyLoss: 30,
        stopLossPercent: 0.8,
        takeProfitPercent: 1.5,
        trailingStopPercent: 0.3
    }
}
```

## 🚀 Usage

### Start Live Trading

```bash
npm start
```

Or directly:

```bash
node index.js
```

### Backtesting

```bash
npm run backtest
```

Or directly:

```bash
node backtesting/runner.js
```

### Development Mode

```bash
npm run dev
```

## 📈 Backtesting

The backtesting system uses historical Binance data:

1. Download data from [Binance Vision](https://data.binance.vision/)
2. Place CSV files in `backtesting/data/`
3. Run backtest with:

```bash
npm run backtest
```

### Backtest Results

- Trade-by-trade CSV export
- Performance metrics (Win rate, Sharpe ratio, Max drawdown)
- Equity curve analysis
- Detailed strategy analytics

## 📁 Project Structure

```
binance-scalping-bot/
├── index.js                 # Main application entry point
├── scalpingBot.js           # Core trading bot logic
├── config.js                # Configuration settings
├── strategies/
│   ├── baseStrategy.js      # Base strategy class
│   ├── advancedScalping.js  # Advanced scalping strategy
│   └── strategyFactory.js   # Strategy factory pattern
├── binanceClient.js         # Binance API client
├── indicators.js            # Technical indicators
├── backtesting/
│   ├── backtester.js        # Backtesting engine
│   ├── runner.js            # Backtest runner
│   └── data/                # Historical data directory
└── results/                 # Backtest results output
```

## 🎯 Strategy Logic

### Entry Conditions (Require 3/6 confirmations)

1. **EMA Crossover** - Fast EMA above/below Slow EMA
2. **RSI Range** - RSI between 25-75 (avoid extremes)
3. **MACD Signal** - MACD line above/below signal line
4. **MACD Histogram** - Positive/negative histogram
5. **Volume Strength** - Volume > 80% of average
6. **Price Momentum** - Recent price movement > 0.05%

### Exit Conditions

- **Take Profit:** 1.5%
- **Stop Loss:** 0.8%
- **Time-based:** 5 minutes maximum
- **Trailing Stop:** 0.3%

## ⚠️ Risk Warning

- Test thoroughly on demo account before live trading
- Start small with minimum position sizes
- Monitor performance regularly
- Set strict daily loss limits
- Understand leverage risks

## 🔧 Development

### Adding New Strategies

1. Extend `BaseStrategy` class
2. Implement `analyze()` method
3. Add to `strategyFactory.js`
4. Update config with strategy name

### Custom Indicators

Add new technical indicators in `indicators.js`:

```javascript
static newIndicator(data, period) {
    // Your indicator logic
}
```

## 📊 Performance Monitoring

The bot provides real-time monitoring:

- Open positions and PnL
- Trade execution logs
- Account balance updates
- Strategy signal details

## 🐛 Troubleshooting

### Common Issues

- **API Connection** - Check API keys and environment
- **Insufficient Balance** - Verify account funding
- **Leverage Errors** - Check symbol leverage limits
- **Minimum Notional** - Increase position size if too small

### Logs

- Detailed console logging for debugging
- Trade execution records
- Error handling with stack traces

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Commit changes
4. Push to branch
5. Create Pull Request

## 📞 Support

For issues and questions:

- Check existing GitHub issues
- Create new issue with detailed description
- Include logs and configuration details

---

**⚡ Happy Trading! Remember to always practice responsible trading and risk management.**