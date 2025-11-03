class Indicators {
    // Simple Moving Average
    static SMA(data, period) {
        if (data.length < period) return null;
        const sum = data.slice(-period).reduce((a, b) => a + b, 0);
        return sum / period;
    }

    // Exponential Moving Average
    static EMA(data, period) {
        if (data.length < period) return null;
        
        let ema = data[0];
        const multiplier = 2 / (period + 1);
        
        for (let i = 1; i < data.length; i++) {
            ema = (data[i] - ema) * multiplier + ema;
        }
        
        return ema;
    }

    // Relative Strength Index
    static RSI(data, period = 14) {
        if (data.length < period + 1) return null;

        let gains = 0;
        let losses = 0;

        // Calculate initial gains and losses
        for (let i = 1; i <= period; i++) {
            const difference = data[i] - data[i - 1];
            if (difference >= 0) {
                gains += difference;
            } else {
                losses -= difference;
            }
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        // Calculate subsequent values
        for (let i = period + 1; i < data.length; i++) {
            const difference = data[i] - data[i - 1];
            
            if (difference >= 0) {
                avgGain = (avgGain * (period - 1) + difference) / period;
                avgLoss = (avgLoss * (period - 1)) / period;
            } else {
                avgGain = (avgGain * (period - 1)) / period;
                avgLoss = (avgLoss * (period - 1) - difference) / period;
            }
        }

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    // MACD
// MACD - Fixed version
static MACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (data.length < slowPeriod + signalPeriod) return null;

    // Calculate MACD line
    const fastEMA = this.EMA(data, fastPeriod);
    const slowEMA = this.EMA(data, slowPeriod);
    
    if (fastEMA === null || slowEMA === null) return null;
    
    const macdLine = fastEMA - slowEMA;
    
    // Calculate signal line (EMA of MACD line)
    // We need historical MACD values for this
    const macdHistory = [];
    for (let i = slowPeriod; i < data.length; i++) {
        const slice = data.slice(0, i + 1);
        const fast = this.EMA(slice, fastPeriod);
        const slow = this.EMA(slice, slowPeriod);
        if (fast && slow) {
            macdHistory.push(fast - slow);
        }
    }
    
    if (macdHistory.length < signalPeriod) return null;
    
    const signalLine = this.EMA(macdHistory, signalPeriod);
    const histogram = macdLine - signalLine;
    
    return {
        macd: macdLine,
        signalLine: signalLine,
        histogram: histogram
    };
}

    // Bollinger Bands
    static BollingerBands(data, period = 20, stdDev = 2) {
        if (data.length < period) return null;

        const slice = data.slice(-period);
        const mean = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
        const standardDeviation = Math.sqrt(variance);

        return {
            upper: mean + (standardDeviation * stdDev),
            middle: mean,
            lower: mean - (standardDeviation * stdDev)
        };
    }
}

module.exports = Indicators;