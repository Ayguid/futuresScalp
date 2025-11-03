const BaseStrategy = require('./baseStrategy');
const Indicators = require('../indicators');

class MacdStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.name = 'macd';
        this.fastPeriod = config.strategy.fastPeriod || 12;
        this.slowPeriod = config.strategy.slowPeriod || 26;
        this.signalPeriod = config.strategy.signalPeriod || 9;
        this.previousSignal = null;
    }

    analyze(data) {
        const closes = data.map(d => d.close);
        
        if (closes.length < this.slowPeriod + this.signalPeriod) {
            return { signal: 'HOLD', reason: 'Insufficient data for MACD' };
        }

        // ✅ ACTUALLY USING the Indicators.MACD function that already exists!
        const macdResult = Indicators.MACD(closes, this.fastPeriod, this.slowPeriod, this.signalPeriod);
        
        if (!macdResult) {
            return { signal: 'HOLD', reason: 'MACD calculation failed' };
        }

        const currentPrice = closes[closes.length - 1];
        const { macd, signalLine, histogram } = macdResult;

        // MACD Strategy Rules
        let signal = 'HOLD';
        let reason = '';

        // Bullish: MACD crosses above signal line
        if (macd > signalLine && this.previousSignal !== 'BUY') {
            signal = 'BUY';
            reason = `MACD bullish (${macd.toFixed(4)} > ${signalLine.toFixed(4)})`;
        } 
        // Bearish: MACD crosses below signal line
        else if (macd < signalLine && this.previousSignal !== 'SELL') {
            signal = 'SELL';
            reason = `MACD bearish (${macd.toFixed(4)} < ${signalLine.toFixed(4)})`;
        }

        if (signal !== 'HOLD') {
            this.previousSignal = signal;
            return { 
                signal: signal, 
                reason: reason,
                price: currentPrice,
                indicators: { 
                    macd: macd, 
                    signalLine: signalLine, 
                    histogram: histogram 
                }
            };
        }

        return { signal: 'HOLD', reason: 'No MACD signal' };
    }
    // ❌ NO NEED for calculateMACD() or calculateEMA() methods anymore!
    // We're using the existing Indicators functions
}

module.exports = MacdStrategy;