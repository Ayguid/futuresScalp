const BaseStrategy = require('./baseStrategy');
const Indicators = require('../indicators');

class RsiStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.name = 'rsi';
        this.rsiPeriod = config.strategy.rsiPeriod || 14;
        this.oversold = config.strategy.rsiOversold || 30;
        this.overbought = config.strategy.rsiOverbought || 70;
        this.previousSignal = null;
    }

    analyze(data) {
        const closes = data.map(d => d.close);
        
        if (closes.length < this.rsiPeriod) {
            return { signal: 'HOLD', reason: 'Insufficient data' };
        }

        const rsi = Indicators.RSI(closes, this.rsiPeriod);
        const currentPrice = closes[closes.length - 1];

        if (!rsi) {
            return { signal: 'HOLD', reason: 'RSI calculation failed' };
        }

        if (rsi < this.oversold && this.previousSignal !== 'BUY') {
            this.previousSignal = 'BUY';
            return { 
                signal: 'BUY', 
                reason: `RSI oversold (${rsi.toFixed(1)})`,
                price: currentPrice
            };
        } 
        else if (rsi > this.overbought && this.previousSignal !== 'SELL') {
            this.previousSignal = 'SELL';
            return { 
                signal: 'SELL', 
                reason: `RSI overbought (${rsi.toFixed(1)})`,
                price: currentPrice
            };
        }

        return { signal: 'HOLD', reason: 'RSI in neutral zone' };
    }
}

module.exports = RsiStrategy;