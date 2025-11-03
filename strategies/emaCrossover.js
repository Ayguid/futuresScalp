const BaseStrategy = require('./baseStrategy');
const Indicators = require('../indicators');

class EmaCrossoverStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.name = 'ema_crossover';
        this.fastEMA = config.strategy.fastEMA || 9;
        this.slowEMA = config.strategy.slowEMA || 21;
        this.previousSignal = null;
    }

    analyze(data) {
        const closes = data.map(d => d.close);
        
        if (closes.length < this.slowEMA) {
            return { signal: 'HOLD', reason: 'Insufficient data' };
        }

        const fastEMA = Indicators.EMA(closes, this.fastEMA);
        const slowEMA = Indicators.EMA(closes, this.slowEMA);

        if (!fastEMA || !slowEMA) {
            return { signal: 'HOLD', reason: 'Indicator calculation failed' };
        }

        const currentPrice = closes[closes.length - 1];
        
        if (fastEMA > slowEMA && this.previousSignal !== 'BUY') {
            this.previousSignal = 'BUY';
            return { 
                signal: 'BUY', 
                reason: `EMA crossover (${this.fastEMA}>${this.slowEMA})`,
                price: currentPrice
            };
        } 
        else if (fastEMA < slowEMA && this.previousSignal !== 'SELL') {
            this.previousSignal = 'SELL';
            return { 
                signal: 'SELL', 
                reason: `EMA crossover (${this.fastEMA}<${this.slowEMA})`,
                price: currentPrice
            };
        }

        return { signal: 'HOLD', reason: 'No crossover' };
    }
}

module.exports = EmaCrossoverStrategy;