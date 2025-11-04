class Indicators {
    // Simple Moving Average
    static SMA(data, period) {
        if (data.length < period) return null;
        const sum = data.slice(-period).reduce((a, b) => a + b, 0);
        return sum / period;
    }

    // Exponential Moving Average - FIXED
    static EMA(data, period) {
        if (data.length < period) return null;
        
        // Start with SMA as first EMA value
        let ema = this.SMA(data.slice(0, period), period);
        const multiplier = 2 / (period + 1);
        
        // Calculate EMA for remaining values
        for (let i = period; i < data.length; i++) {
            ema = (data[i] * multiplier) + (ema * (1 - multiplier));
        }
        
        return ema;
    }

    // Relative Strength Index - FIXED (more accurate calculation)
    static RSI(data, period = 14) {
        if (data.length < period + 1) return null;

        let gains = [];
        let losses = [];

        // Calculate price changes
        for (let i = 1; i < data.length; i++) {
            const change = data[i] - data[i - 1];
            gains.push(change > 0 ? change : 0);
            losses.push(change < 0 ? Math.abs(change) : 0);
        }

        // Calculate initial averages
        let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
        let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

        // Handle edge case where avgLoss is 0
        if (avgLoss === 0) return 100;

        // Calculate subsequent values using Wilder's smoothing
        for (let i = period; i < gains.length; i++) {
            avgGain = ((avgGain * (period - 1)) + gains[i]) / period;
            avgLoss = ((avgLoss * (period - 1)) + losses[i]) / period;
        }

        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
    }

    // Simple RSI for quick calculations (less accurate but faster)
    static simpleRSI(data, period = 14) {
        if (data.length < period + 1) return null;

        let gains = 0;
        let losses = 0;

        // Calculate only the most recent period
        for (let i = data.length - period; i < data.length; i++) {
            const change = data[i] - data[i - 1];
            if (change > 0) gains += change;
            else losses -= change;
        }

        const avgGain = gains / period;
        const avgLoss = losses / period;

        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return 100 - (100 / (1 + rs));
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

    // Average True Range - for volatility measurement
    static ATR(highs, lows, closes, period = 14) {
        if (highs.length < period + 1) return null;
        
        const trueRanges = [];
        for (let i = 1; i < highs.length; i++) {
            const tr1 = highs[i] - lows[i];
            const tr2 = Math.abs(highs[i] - closes[i - 1]);
            const tr3 = Math.abs(lows[i] - closes[i - 1]);
            trueRanges.push(Math.max(tr1, tr2, tr3));
        }
        
        return this.SMA(trueRanges, period);
    }

    // Volume Weighted Moving Average
    static VWMA(closes, volumes, period = 20) {
        if (closes.length < period || volumes.length < period) return null;
        
        const closeSlice = closes.slice(-period);
        const volumeSlice = volumes.slice(-period);
        
        let sumPV = 0;
        let sumV = 0;
        
        for (let i = 0; i < period; i++) {
            sumPV += closeSlice[i] * volumeSlice[i];
            sumV += volumeSlice[i];
        }
        
        return sumPV / sumV;
    }

    // 🆕 MACD (Moving Average Convergence Divergence)
    static MACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        if (data.length < slowPeriod) return null;
        
        // Calculate fast and slow EMAs
        const fastEMA = this.EMA(data, fastPeriod);
        const slowEMA = this.EMA(data, slowPeriod);
        
        if (!fastEMA || !slowEMA) return null;
        
        // MACD Line = Fast EMA - Slow EMA
        const macdLine = fastEMA - slowEMA;
        
        // Calculate signal line (EMA of MACD line)
        // We need to build an array of MACD values
        const macdValues = [];
        
        // Calculate MACD for each point where we have enough data
        for (let i = slowPeriod - 1; i < data.length; i++) {
            const slice = data.slice(0, i + 1);
            const fast = this.EMA(slice, fastPeriod);
            const slow = this.EMA(slice, slowPeriod);
            if (fast && slow) {
                macdValues.push(fast - slow);
            }
        }
        
        // Calculate signal line (EMA of MACD values)
        const signalLine = macdValues.length >= signalPeriod 
            ? this.EMA(macdValues, signalPeriod) 
            : null;
        
        if (!signalLine) return null;
        
        // Histogram = MACD Line - Signal Line
        const histogram = macdLine - signalLine;
        
        return {
            MACD: macdLine,
            signal: signalLine,
            histogram: histogram
        };
    }

    // 🆕 TREND STRENGTH INDICATOR
    static trendStrength(closes, fastPeriod = 8, slowPeriod = 21) {
        const fastEMA = this.EMA(closes, fastPeriod);
        const slowEMA = this.EMA(closes, slowPeriod);
        
        if (!fastEMA || !slowEMA) return 0;
        
        // Returns values from -1 (strong downtrend) to +1 (strong uptrend)
        return (fastEMA - slowEMA) / slowEMA;
    }
}

module.exports = Indicators;