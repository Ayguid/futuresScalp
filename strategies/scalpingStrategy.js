const BaseStrategy = require('./baseStrategy');
const Indicators = require('../indicators');

class ScalpingStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.name = 'scalping';
        this.fastEMA = config.strategy.fastEMA || 9;
        this.slowEMA = config.strategy.slowEMA || 21;
        this.rsiPeriod = config.strategy.rsiPeriod || 14;
        
        this.previousSignal = null;
        this.position = null;
    }

    analyze(data) {
        const closes = data.map(d => d.close);
        
        if (closes.length < this.slowEMA) {
            return { signal: 'HOLD', reason: 'Insufficient data' };
        }

        const fastEMA = Indicators.EMA(closes, this.fastEMA);
        const slowEMA = Indicators.EMA(closes, this.slowEMA);
        const rsi = Indicators.RSI(closes, this.rsiPeriod);

        if (fastEMA === null || slowEMA === null || rsi === null) {
            return { signal: 'HOLD', reason: 'Indicator calculation failed' };
        }

        const currentPrice = closes[closes.length - 1];
        
        // EMA Crossover Strategy
        if (fastEMA > slowEMA && this.previousSignal !== 'BUY') {
            if (rsi < 60 && rsi > 30) {
                this.previousSignal = 'BUY';
                return { 
                    signal: 'BUY', 
                    reason: `EMA crossover (${this.fastEMA}>${this.slowEMA}), RSI: ${rsi.toFixed(2)}`,
                    price: currentPrice,
                    indicators: { fastEMA, slowEMA, rsi }
                };
            }
        } 
        else if (fastEMA < slowEMA && this.previousSignal !== 'SELL') {
            if (rsi > 40 && rsi < 70) {
                this.previousSignal = 'SELL';
                return { 
                    signal: 'SELL', 
                    reason: `EMA crossover (${this.fastEMA}<${this.slowEMA}), RSI: ${rsi.toFixed(2)}`,
                    price: currentPrice,
                    indicators: { fastEMA, slowEMA, rsi }
                };
            }
        }

        return { signal: 'HOLD', reason: 'No clear signal or conditions not met' };
    }

    // ❌ REMOVE calculatePositionSize and calculateLevels methods
    // They are now inherited from BaseStrategy
}

module.exports = ScalpingStrategy;