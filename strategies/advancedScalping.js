const BaseStrategy = require('./baseStrategy');
const Indicators = require('../indicators');

class AdvancedScalpingStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.name = 'advanced_scalping';
        this.fastEMA = config.strategy.fastEMA || 3;
        this.slowEMA = config.strategy.slowEMA || 8;
        this.rsiPeriod = config.strategy.rsiPeriod || 10;
        this.rsiOversold = config.strategy.rsiOversold || 25;
        this.rsiOverbought = config.strategy.rsiOverbought || 75;
        this.volumeThreshold = config.strategy.volumeThreshold || 1.5;
        this.maxHoldTime = config.strategy.maxHoldTime || 300; // 5 minutes in seconds
        this.entryTimes = new Map(); // Track when positions were entered
        this.previousSignal = 'HOLD';
        this.minConfirmationScore = 3; // 🆕 ADD THIS - makes it easy to change requirement
        this.momentumThreshold = config.strategy.momentumThreshold || 0.05;
    }

analyze(data, symbol = '') {
    const closes = data.map(d => d.close);
    const volumes = data.map(d => d.volume);
    const currentTime = Date.now();
        
    if (closes.length < 30) {
        return { signal: 'HOLD', reason: 'Insufficient data' };
    }

    const currentPrice = closes[closes.length - 1];

    // Check for existing position first
    if (symbol && this.hasActivePosition(symbol) && !this.config.backtesting) {
        if (this.shouldExitByTime(symbol, currentTime)) {
            this.recordExit(symbol);
            return { 
                signal: 'EXIT', 
                reason: `Max hold time (${this.maxHoldTime}s) exceeded`,
                price: currentPrice
            };
        }
        return { 
            signal: 'HOLD', 
            reason: 'Position active, waiting for TP/SL or time exit',
            price: currentPrice
        };
    }

    // Multiple indicators
    const fastEMA = Indicators.EMA(closes, this.fastEMA);
    const slowEMA = Indicators.EMA(closes, this.slowEMA);
    const rsi = Indicators.RSI(closes, this.rsiPeriod);
    const macd = Indicators.MACD(closes, 8, 21, 5);
    const volumeStrength = this.calculateVolumeStrength(volumes);
    const priceMomentum = this.calculateMomentum(closes);

    if (!fastEMA || !slowEMA || !rsi || !macd) {
        return { signal: 'HOLD', reason: 'Indicator calculation failed' };
    }

    // 🆕 FORCE DEBUG - LOG EVERY ANALYSIS FOR FIRST 1000 POINTS
    if (closes.length <= 1000) {
        console.log(`\n🔍 ${symbol} STRATEGY DEBUG - Analysis #${closes.length}:`);
        console.log(`   Price: ${currentPrice}`);
        console.log(`   EMA ${this.fastEMA}/${this.slowEMA}: ${fastEMA.toFixed(1)} vs ${slowEMA.toFixed(1)} (${fastEMA > slowEMA ? 'BULL' : 'BEAR'})`);
        console.log(`   RSI ${this.rsiPeriod}: ${rsi.toFixed(1)} (need ${this.rsiOversold}-${this.rsiOverbought}) ${rsi > this.rsiOversold && rsi < this.rsiOverbought ? '✅' : '❌'}`);
        console.log(`   MACD Line: ${macd.macd.toFixed(4)} vs Signal: ${macd.signalLine.toFixed(4)} (${macd.macd > macd.signalLine ? 'BULL' : 'BEAR'})`);
        console.log(`   MACD Histogram: ${macd.histogram.toFixed(4)} ${macd.histogram > 0 ? 'POSITIVE' : 'NEGATIVE'}`);
        console.log(`   Volume Strength: ${volumeStrength.toFixed(2)}x (threshold: ${this.volumeThreshold})`);
        console.log(`   Price Momentum: ${priceMomentum.toFixed(2)}%`);
    }

    // BULLISH: Multiple confirmations required
    const bullishConfirmations = [
        fastEMA > slowEMA,
        rsi > this.rsiOversold && rsi < this.rsiOverbought,
        macd.macd > macd.signalLine,
        macd.histogram > 0,
        volumeStrength > this.volumeThreshold,
        priceMomentum > this.momentumThreshold || 0.05
    ];

    // BEARISH: Multiple confirmations required
    const bearishConfirmations = [
        fastEMA < slowEMA,
        rsi > this.rsiOversold && rsi < this.rsiOverbought,
        macd.macd < macd.signalLine,
        macd.histogram < 0,
        volumeStrength > this.volumeThreshold,
        priceMomentum < -(this.momentumThreshold || 0.05)
    ];

    const bullishScore = bullishConfirmations.filter(Boolean).length;
    const bearishScore = bearishConfirmations.filter(Boolean).length;

    // 🆕 ALWAYS LOG SCORES FOR FIRST 1000 POINTS
    if (closes.length <= 1000) {
        console.log(`   🎯 Bull Score: ${bullishScore}/6, Bear Score: ${bearishScore}/6`);
        console.log(`   📊 Need ${this.minConfirmationScore || 3}/6 for trade`);
        
        // Show which conditions passed/failed
        console.log(`   📋 Bull Conditions: EMA=${fastEMA > slowEMA ? '✅' : '❌'} RSI=${rsi > this.rsiOversold && rsi < this.rsiOverbought ? '✅' : '❌'} MACD=${macd.macd > macd.signalLine ? '✅' : '❌'} Hist=${macd.histogram > 0 ? '✅' : '❌'} Vol=${volumeStrength > this.volumeThreshold ? '✅' : '❌'} Mom=${priceMomentum > (this.momentumThreshold || 0.05) ? '✅' : '❌'}`);
        console.log(`   📋 Bear Conditions: EMA=${fastEMA < slowEMA ? '✅' : '❌'} RSI=${rsi > this.rsiOversold && rsi < this.rsiOverbought ? '✅' : '❌'} MACD=${macd.macd < macd.signalLine ? '✅' : '❌'} Hist=${macd.histogram < 0 ? '✅' : '❌'} Vol=${volumeStrength > this.volumeThreshold ? '✅' : '❌'} Mom=${priceMomentum < -(this.momentumThreshold || 0.05) ? '✅' : '❌'}`);
    }

    // Require at least 3 out of 6 confirmations
    const minScore = this.minConfirmationScore || 3;
    if (bullishScore >= minScore && this.previousSignal !== 'BUY') {
        this.previousSignal = 'BUY';
        if (symbol) this.recordEntry(symbol);
        console.log(`🎯 ${new Date().toISOString()} - BUY SIGNAL! Score: ${bullishScore}/6`);
        return { 
            signal: 'BUY', 
            reason: `Multi-confirmation bullish (${bullishScore}/6)`,
            price: currentPrice,
            indicators: { 
                fastEMA, 
                slowEMA, 
                rsi, 
                macd: macd.macd, 
                signalLine: macd.signalLine,
                volumeStrength, 
                priceMomentum 
            }
        };
    }

    if (bearishScore >= minScore && this.previousSignal !== 'SELL') {
        this.previousSignal = 'SELL';
        if (symbol) this.recordEntry(symbol);
        console.log(`🎯 ${new Date().toISOString()} - SELL SIGNAL! Score: ${bearishScore}/6`);
        return { 
            signal: 'SELL', 
            reason: `Multi-confirmation bearish (${bearishScore}/6)`,
            price: currentPrice,
            indicators: { 
                fastEMA, 
                slowEMA, 
                rsi, 
                macd: macd.macd, 
                signalLine: macd.signalLine,
                volumeStrength, 
                priceMomentum 
            }
        };
    }

    return { 
        signal: 'HOLD', 
        reason: `Insufficient confirmation (Bull:${bullishScore}/6, Bear:${bearishScore}/6)`,
        indicators: { fastEMA, slowEMA, rsi, volumeStrength, priceMomentum }
    };
}
    // 🆕 ADD THIS METHOD to track active positions
    hasActivePosition(symbol) {
        return this.entryTimes.has(symbol);
    }
    // Time-based exit for scalping
    shouldExitByTime(symbol, currentTime) {
        const entryTime = this.entryTimes.get(symbol);
        if (!entryTime) return false;

        const timeInTrade = (currentTime - entryTime) / 1000; // Convert to seconds
        return timeInTrade > this.maxHoldTime;
    }

    // Track when positions are opened
    recordEntry(symbol) {
        this.entryTimes.set(symbol, Date.now());
        console.log(`⏰ ${symbol} - Entry time recorded for max ${this.maxHoldTime}s hold`);
    }

    // Clear tracking when positions are closed
    recordExit(symbol) {
        this.entryTimes.delete(symbol);
        console.log(`⏰ ${symbol} - Exit time recorded`);
    }

calculateVolumeStrength(volumes) {
    if (volumes.length < 10) return 1;
    const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const averageVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    
    // 🆕 DEBUG VOLUME CALCULATION
    if (Math.random() < 0.01) {
        console.log(`📊 VOLUME DEBUG: Recent=${recentVolume.toFixed(2)}, Avg=${averageVolume.toFixed(2)}, Ratio=${(recentVolume/averageVolume).toFixed(2)}`);
    }
    
    return recentVolume / averageVolume;
}

    calculateMomentum(closes) {
        if (closes.length < 5) return 0;
        const recent = closes.slice(-3);
        return ((recent[2] - recent[0]) / recent[0]) * 100;
    }

    // Override for scalping-specific position sizing
    calculatePositionSize(accountBalance, price, stopLossPercent) {
        const positionPercent = this.config.trading.positionPercent || 1; // Use 1% for scalping
        const positionValue = accountBalance * (positionPercent / 100);

        let quantity = positionValue / price;

        const minPositionValue = this.config.trading.minPositionValue || 50; // Lower minimum
        if (positionValue < minPositionValue) {
            quantity = minPositionValue / price;
        }

        const maxQuantity = this.config.trading.maxPositionSize / price;
        return Math.min(quantity, maxQuantity);
    }

    // Override for tighter scalping levels
    // In AdvancedScalpingStrategy - FIXED VERSION
    calculateLevels(entryPrice, side) {
        // Get values from config instead of parameters
        const sl = this.config.risk.stopLossPercent || 0.8;   // 0.8% for scalping
        const tp = this.config.risk.takeProfitPercent || 1.5; // 1.5% for scalping

        console.log(`🔧 Calculating levels: Entry=${entryPrice}, Side=${side}, SL=${sl}%, TP=${tp}%`);

        if (side === 'BUY') {
            // LONG position: SL below entry, TP above entry
            const stopLoss = entryPrice * (1 - sl / 100);
            const takeProfit = entryPrice * (1 + tp / 100);
            console.log(`🔧 LONG: Entry=${entryPrice}, SL=${stopLoss.toFixed(6)}, TP=${takeProfit.toFixed(6)}`);
            return { stopLoss, takeProfit };
        } else {
            // SHORT position: SL above entry, TP below entry  
            const stopLoss = entryPrice * (1 + sl / 100);
            const takeProfit = entryPrice * (1 - tp / 100);
            console.log(`🔧 SHORT: Entry=${entryPrice}, SL=${stopLoss.toFixed(6)}, TP=${takeProfit.toFixed(6)}`);
            return { stopLoss, takeProfit };
        }
    }


}

module.exports = AdvancedScalpingStrategy;