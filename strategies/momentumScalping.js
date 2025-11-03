const BaseStrategy = require('./baseStrategy');
const Indicators = require('../indicators');

class MomentumScalpingStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.name = 'momentum_scalping';
    }

    analyze(data) {
        const closes = data.map(d => d.close);
        const highs = data.map(d => d.high);
        const lows = data.map(d => d.low);
        
        if (closes.length < 20) {
            return { signal: 'HOLD', reason: 'Insufficient data' };
        }

        // Multiple timeframe analysis
        const ema8 = Indicators.EMA(closes, 8);
        const ema21 = Indicators.EMA(closes, 21);
        const rsi = Indicators.RSI(closes, 14);
        const stoch = this.calculateStochastic(highs, lows, closes, 14);
        const atr = this.calculateATR(highs, lows, closes, 14);
        const currentPrice = closes[closes.length - 1];

        // Breakout detection
        const recentHigh = Math.max(...highs.slice(-5));
        const recentLow = Math.min(...lows.slice(-5));

        // Momentum scalping logic
        const breakoutUp = currentPrice > recentHigh && 
                          ema8 > ema21 && 
                          rsi > 50 && rsi < 75;

        const breakdown = currentPrice < recentLow && 
                         ema8 < ema21 && 
                         rsi > 25 && rsi < 50;

        if (breakoutUp && this.previousSignal !== 'BUY') {
            this.previousSignal = 'BUY';
            return { 
                signal: 'BUY', 
                reason: `Momentum breakout (Price > ${recentHigh.toFixed(2)})`,
                price: currentPrice
            };
        }

        if (breakdown && this.previousSignal !== 'SELL') {
            this.previousSignal = 'SELL';
            return { 
                signal: 'SELL', 
                reason: `Momentum breakdown (Price < ${recentLow.toFixed(2)})`,
                price: currentPrice
            };
        }

        return { signal: 'HOLD', reason: 'No momentum setup' };
    }

    calculateStochastic(highs, lows, closes, period) {
        // Simplified stochastic
        const currentClose = closes[closes.length - 1];
        const periodHigh = Math.max(...highs.slice(-period));
        const periodLow = Math.min(...lows.slice(-period));
        return ((currentClose - periodLow) / (periodHigh - periodLow)) * 100;
    }

    calculateATR(highs, lows, closes, period) {
        // Average True Range for volatility
        const trueRanges = [];
        for (let i = 1; i < closes.length; i++) {
            const tr = Math.max(
                highs[i] - lows[i],
                Math.abs(highs[i] - closes[i-1]),
                Math.abs(lows[i] - closes[i-1])
            );
            trueRanges.push(tr);
        }
        return trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
    }
}

module.exports = MomentumScalpingStrategy;