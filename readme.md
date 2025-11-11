# Binance Futures Scalping Bot 🤖

A high-frequency scalping bot for Binance Futures with advanced technical analysis, risk management, and automated trading capabilities.

## 🚀 Features

- **Smart Scalping Strategy** - Multi-indicator confirmation system (EMA, RSI, Volume, Momentum)
- **Risk Management** - Automated stop-loss, take-profit, and position limits
- **Multi-Symbol Trading** - Trade multiple pairs simultaneously
- **State Recovery** - Recovers open positions on restart
- **Orphaned Order Cleanup** - Automatically removes dangling TP/SL orders
- **Emergency Failsafe** - Closes unprotected positions immediately
- **Backtesting Engine** - Test strategies on historical data
- **Rate Limiting** - Built-in API request throttling
- **Comprehensive Logging** - Separate logs for errors, positions, and trades

## 📊 Strategy

The bot uses a confirmation-based approach:

- **EMA Analysis** - Trend detection with exponential moving averages
- **RSI Momentum** - Overbought/oversold conditions
- **Volume Confirmation** - Trade validation through volume spikes
- **Price Momentum** - Recent price movement analysis
- **Cooldown System** - Prevents overtrading on same symbol

### Entry Requirements
- Minimum 3 out of 6 indicator confirmations
- No existing position on symbol
- Below maximum position limit
- Sufficient account balance

### Exit Conditions
- **Stop Loss** - Configurable percentage-based protection
- **Take Profit** - Automated profit-taking targets
- **Batch Orders** - Atomic TP/SL placement for safety

## 🛠 Installation

### Prerequisites
- Node.js 16+ 
- Binance Futures account (Testnet or Mainnet)
- API keys with Futures trading permissions

### Setup

```bash
# Clone repository
git clone <your-repo-url>
cd futuresscalping

# Install dependencies
npm install

# Configure environment
cp .env.example .env
```

Edit `.env` with your API credentials:

```env
BOT_ENVIRONMENT=testnet
BINANCE_TESTNET_API_KEY=your_testnet_key
BINANCE_TESTNET_SECRET_KEY=your_testnet_secret
BINANCE_MAINNET_API_KEY=your_mainnet_key
BINANCE_MAINNET_SECRET_KEY=your_mainnet_secret
```

### Configuration

Edit `config.js` to customize trading parameters:

```javascript
{
    environment: 'testnet', // 'testnet' or 'mainnet'
    trading: {
        symbols: ['BTCUSDT', 'ETHUSDT', 'DOGEUSDT'],
        leverage: 10,
        maxOpenPositions: 4,
        positionPercent: 1,
        marginMode: 'ISOLATED'
    },
    risk: {
        stopLossPercent: 0.8,
        takeProfitPercent: 1.5
    },
    strategy: {
        name: 'SimpleScalping',
        timeframe: '1m'
    }
}
```

## 🚀 Usage

### Start Bot

```bash
npm start
# or
node index.js
```

### Run Backtests

```bash
node backtesting/runBacktest.js
```

### Test Connection

```bash
node backtesting/test-testnet.js
```

## 📁 Project Structure

```
futuresscalping/
├── bot/
│   ├── BinanceClient.js       # Binance API wrapper
│   └── ScalpingBot.js         # Main trading bot logic
│
├── strategies/
│   ├── BaseStrategy.js        # Base strategy class
│   ├── SimpleScalping.js      # Scalping implementation
│   └── StrategyFactory.js     # Strategy instantiation
│
├── utils/
│   ├── indicators.js          # Technical indicators (SMA, EMA, RSI, etc.)
│   ├── Logger.js              # Multi-file logging system
│   └── RateLimitedQueue.js    # API rate limit handler
│
├── backtesting/
│   ├── data/                  # Historical data directory
│   ├── results/               # Backtest output files
│   ├── backtester.js          # Backtesting engine
│   ├── runBacktest.js         # Backtest runner
│   └── test-testnet.js        # Connection tester
│
├── logs/                       # Generated log files
│   ├── errors.log             # Error tracking
│   ├── positions.log          # Position history
│   └── trades.log             # Trade execution logs
│
├── config.js                   # Main configuration
├── index.js                    # Application entry point
├── .env                        # Environment variables (not committed)
├── .env.example                # Environment template
└── package.json                # Dependencies and scripts
```

## 🔧 Core Components

### ScalpingBot
Main trading engine that manages:
- Position lifecycle (open, monitor, close)
- State recovery on restart
- Cooldown management
- Emergency position closure
- Orphaned order cleanup

### BinanceClient
Handles all Binance API interactions:
- Account information
- Market data retrieval
- Order placement (market, limit, batch)
- Position management
- Rate limiting

### Strategies
Modular strategy system:
- **BaseStrategy** - Abstract base class with common logic
- **SimpleScalping** - Confirmation-based scalping strategy
- **StrategyFactory** - Dynamic strategy instantiation

### Indicators
Technical analysis toolkit:
- SMA, EMA - Moving averages
- RSI - Relative Strength Index
- Bollinger Bands
- ATR - Average True Range
- VWMA - Volume Weighted Moving Average
- Trend Strength calculations

## 📊 Backtesting

Test strategies on historical data before live trading:

1. **Download Data**
   ```bash
   # Get historical klines from Binance Vision
   https://data.binance.vision/
   https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info
   ```

2. **Place in Data Directory**
   ```
   backtesting/data/BTCUSDT-1m-2024-01.csv
   ```

3. **Run Backtest**
   ```bash
   node backtesting/runBacktest.js
   ```

4. **Check Results**
   ```
   backtesting/results/backtest-[timestamp].csv
   ```

### Backtest Metrics
- Total trades executed
- Win rate percentage
- Profit/Loss ratio
- Maximum drawdown
- Sharpe ratio
- Trade-by-trade breakdown

## 🛡️ Safety Features

### Emergency Failsafe
If TP/SL batch orders fail, the bot immediately closes the position to prevent unprotected exposure.

### Orphaned Order Cleanup
Periodically scans for TP/SL orders without corresponding positions and removes them.

### State Recovery
On restart, the bot:
- Detects existing open positions
- Restores position tracking
- Applies cooldowns to prevent duplicate trades

### Rate Limiting
Built-in queue system prevents API rate limit violations.

## ⚠️ Risk Management

### Best Practices
- ✅ Always test on testnet first
- ✅ Start with minimal position sizes
- ✅ Use isolated margin mode
- ✅ Set conservative leverage (5-10x)
- ✅ Monitor daily loss limits
- ✅ Keep API keys secure
- ✅ Review logs regularly

### Position Limits
Configure in `config.js`:
```javascript
trading: {
    maxOpenPositions: 4,      // Maximum concurrent positions
    positionPercent: 1,       // % of balance per trade
}
```

### Stop Loss / Take Profit
```javascript
risk: {
    stopLossPercent: 0.8,     // -0.8% loss limit
    takeProfitPercent: 1.5,   // +1.5% profit target
}
```

## 📝 Logging

The bot maintains three separate log files:

### `logs/errors.log`
- API errors
- Configuration issues
- Emergency closures
- Critical failures

### `logs/positions.log`
- Position opens
- Position closes
- Recovery operations

### `logs/trades.log`
- Trade signals
- Order executions
- TP/SL placements
- Risk level calculations

View logs programmatically:
```javascript
bot.getLogs('errors');
bot.clearLogs('trades');
```

## 🔍 Monitoring

The bot provides real-time console output with emojis:
- 🔍 Debug information
- ℹ️ General information
- 🎯 Trade signals
- 📊 Position updates
- ❌ Errors and warnings
- 🚨 Emergency actions

## 🐛 Troubleshooting

### Connection Issues
```javascript
// Test API connection
node backtesting/test-testnet.js
```

### Common Errors

**"Margin is insufficient"**
- Reduce position size or leverage
- Check available balance

**"Invalid quantity"**
- Check symbol's quantity precision
- Ensure above minimum notional value

**"Signature verification failed"**
- Verify API keys in `.env`
- Check system time synchronization

**"Rate limit exceeded"**
- Bot has built-in rate limiting
- Reduce trading frequency if needed

## 🎯 Performance Tips

1. **Choose Volatile Pairs** - Better scalping opportunities
2. **Optimize Timeframe** - 1m or 3m for scalping
3. **Adjust Confirmations** - Balance between trades and accuracy
4. **Monitor Spreads** - Avoid high-spread symbols
5. **Backtest First** - Validate strategy before live trading

## 🔄 Adding Custom Strategies

1. Create new strategy file:
```javascript
// strategies/MyStrategy.js
import BaseStrategy from '#strategies/BaseStrategy';

class MyStrategy extends BaseStrategy {
    analyze(klines, symbol) {
        // Your strategy logic
        return { signal: 'BUY', price: currentPrice, reason: '...' };
    }
}

export default MyStrategy;
```

2. Register in StrategyFactory:
```javascript
// strategies/StrategyFactory.js
case 'MyStrategy':
    return new MyStrategy(config);
```

3. Update config:
```javascript
strategy: {
    name: 'MyStrategy'
}
```

## 📦 Dependencies

```json
{
    "axios": "^1.6.0",
    "dotenv": "^16.0.0",
    "crypto": "built-in"
}
```

## 🤝 Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create feature branch (`git checkout -b feature/improvement`)
3. Commit changes (`git commit -am 'Add new feature'`)
4. Push to branch (`git push origin feature/improvement`)
5. Create Pull Request

## 📄 License

MIT License - See LICENSE file for details

## ⚡ Disclaimer

**This bot is for educational purposes. Cryptocurrency trading carries significant risk. Always:**
- Test thoroughly on testnet
- Start with small amounts
- Never invest more than you can afford to lose
- Understand the risks of leverage trading
- Monitor bot performance regularly

**The authors are not responsible for any financial losses incurred while using this software.**

---

**🚀 Happy Trading! Practice safe risk management and start small.**