Scalping Bot Strategy Guide
Available Strategies
1. Scalping Strategy (Original)
Config Name: scalping

javascript
strategy: {
    name: 'scalping',
    // EMA Parameters
    fastEMA: 9,      // Fast EMA period
    slowEMA: 21,     // Slow EMA period
    // RSI Parameters  
    rsiPeriod: 14,   // RSI period
    rsiOversold: 30, // Buy when RSI below this
    rsiOverbought: 70 // Sell when RSI above this
}
Best For: Conservative scalping with RSI confirmation
Signal Logic: EMA crossover + RSI filter

2. EMA Crossover Strategy
Config Name: ema_crossover

javascript
strategy: {
    name: 'ema_crossover',
    // EMA Parameters
    fastEMA: 5,      // More sensitive (5-9)
    slowEMA: 10,     // More sensitive (10-21)
    // Alternative settings:
    // fastEMA: 9,   // Standard
    // slowEMA: 21   // Standard
}
Best For: Fast-paced scalping, quick entries/exits
Signal Logic: Pure EMA crossover (faster signals)

3. RSI Strategy
Config Name: rsi

javascript
strategy: {
    name: 'rsi',
    // RSI Parameters
    rsiPeriod: 14,   // Standard RSI period
    rsiOversold: 25, // Aggressive - buy earlier
    rsiOverbought: 75 // Aggressive - sell earlier
    
    // Alternative (Conservative):
    // rsiOversold: 30,
    // rsiOverbought: 70
    
    // Alternative (Very Aggressive):
    // rsiOversold: 20,
    // rsiOverbought: 80
}
Best For: Range-bound markets, reversal trading
Signal Logic: RSI overbought/oversold levels

4. MACD Strategy
Config Name: macd

javascript
strategy: {
    name: 'macd',
    // MACD Parameters
    fastPeriod: 12,     // Fast EMA period
    slowPeriod: 26,     // Slow EMA period  
    signalPeriod: 9,    // Signal line period
    
    // Alternative (Faster):
    // fastPeriod: 8,
    // slowPeriod: 21,
    // signalPeriod: 5
}
Best For: Trend-following, momentum trading
Signal Logic: MACD line vs Signal line crossover
Note: Needs 35+ data points to work properly

Quick Strategy Comparison
Strategy	Speed	Risk	Best Market	Signals/Day
EMA Crossover	🚀 Fast	Medium	Trending	High
RSI	⚡ Very Fast	High	Ranging	Very High
MACD	🐢 Slow	Low	Trending	Low
Scalping	🎯 Balanced	Medium	Mixed	Medium
Recommended Starting Points
For Beginners:
javascript
strategy: {
    name: 'scalping',  // Balanced approach
    fastEMA: 9,
    slowEMA: 21,
    rsiPeriod: 14,
    rsiOversold: 30,
    rsiOverbought: 70
}
For Aggressive Trading:
javascript
strategy: {
    name: 'ema_crossover',  // Faster signals
    fastEMA: 5,
    slowEMA: 10
}
For Conservative Trading:
javascript
strategy: {
    name: 'macd',  // Slower, more reliable
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9
}
Timeframe Recommendations
1m: Very fast, high frequency (RSI/EMA Crossover)

5m: Balanced (All strategies)

15m: Slower, more reliable (MACD/Scalping)

Risk Management Settings
javascript
risk: {
    maxDailyLoss: 50,           // Max $ loss per day
    stopLossPercent: 1.0,       // 1% stop loss
    takeProfitPercent: 2.0,     // 2% take profit  
    trailingStopPercent: 0.5    // 0.5% trailing stop
}
Position Sizing
javascript
trading: {
    symbols: ['BTCUSDT', 'ETHUSDT', 'ADAUSDT'],
    leverage: 10,
    maxPositionSize: 200,       // Max $ per trade
    maxOpenPositions: 2,        // Max simultaneous trades
    positionPercent: 2,         // 2% of account per trade
    minPositionValue: 110       // Min $ per trade (Binance requirement)
}
Quick Switch Examples
Switch to RSI Strategy:
javascript
strategy: {
    name: 'rsi',
    rsiPeriod: 14,
    rsiOversold: 25,
    rsiOverbought: 75
}
Switch to Fast EMA:
javascript
strategy: {
    name: 'ema_crossover', 
    fastEMA: 5,
    slowEMA: 10
}
Switch to MACD:
javascript
strategy: {
    name: 'macd',
    fastPeriod: 12,
    slowPeriod: 26, 
    signalPeriod: 9
}


strategy: {
    name: 'advanced_scalping', // Much better than single indicator
    
    // Advanced Scalping parameters
    fastEMA: 5,
    slowEMA: 15,
    rsiPeriod: 14,
    volumeThreshold: 1.2,
    
    // Momentum Scalping parameters
    breakoutPeriod: 5,
    // ... etc
}


Testing Commands
bash
# Test all strategies
node testAllStrategies.js

# Test specific strategy
node testMacdStrategy.js

# Test with real market data  
node testMacdReal.js

# Check current positions
node checkPositions.js