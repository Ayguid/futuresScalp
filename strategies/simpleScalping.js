const BaseStrategy = require('./baseStrategy');
const Indicators = require('../indicators');

class SimpleScalpingStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.name = 'simple_scalping';
        this.positions = new Map();
        this.isBacktest = true;
        this.tradeCount = 0;
        this.lastSignal = null;
        
        console.log('🎯 FIXED SCALPING STRATEGY - QUALITY OVER QUANTITY');
    }

    analyze(data, symbol = '') {
        try {
            if (data.length < 100) return { signal: 'HOLD', reason: 'Insufficient data' };

            const currentCandle = data[data.length - 1];
            const currentPrice = currentCandle.close;
            const currentVolume = currentCandle.volume;
            const currentHigh = currentCandle.high;
            const currentLow = currentCandle.low;

            const closes = data.map(d => d.close);
            const highs = data.map(d => d.high);
            const lows = data.map(d => d.low);
            const volumes = data.map(d => d.volume);
            
            // Key indicators
            const ema20 = Indicators.EMA(closes, 20);
            const ema50 = Indicators.EMA(closes, 50);
            const rsi = Indicators.RSI(closes, 14);
            const atr = Indicators.ATR(highs, lows, closes, 14);
            
            if (!ema20 || !ema50 || !rsi || !atr) {
                return { signal: 'HOLD', reason: 'Indicators not ready' };
            }

            // Volume analysis
            const volumeAvg = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            const volumeRatio = currentVolume / volumeAvg;

            // 🎯 IMPROVED TREND DETECTION
            const trendStrength = this.getTrendStrength(closes, ema20, ema50);
            const atrPercentage = (atr / currentPrice) * 100;

            // 🚫 STRICT FILTERS TO REDUCE FALSE SIGNALS
            if (volumeRatio < 1.2) {
                return { signal: 'HOLD', reason: 'Low volume' };
            }

            if (atrPercentage < 0.3) {
                return { signal: 'HOLD', reason: 'Low volatility' };
            }

            // 🎯 HIGH-QUALITY SETUPS ONLY

            // 🟢 STRONG BULLISH SETUP
            const strongBuyCondition = 
                trendStrength === 'strong_bullish' &&
                currentPrice > ema20 && // Above EMA20
                rsi > 45 && rsi < 65 && // Healthy RSI
                volumeRatio > 1.3 && // Strong volume
                currentPrice > currentLow * 1.005 && // Showing strength
                this.isBullishCandle(currentCandle); // Bullish candle confirmation

            // 🔴 STRONG BEARISH SETUP
            const strongSellCondition =
                trendStrength === 'strong_bearish' &&
                currentPrice < ema20 && // Below EMA20
                rsi < 55 && rsi > 35 && // Healthy RSI
                volumeRatio > 1.3 && // Strong volume
                currentPrice < currentHigh * 0.995 && // Showing weakness
                this.isBearishCandle(currentCandle); // Bearish candle confirmation

            // Only log quality setups
            if (strongBuyCondition || strongSellCondition) {
                console.log(`\n🎯 QUALITY SETUP: Trend=${trendStrength}, RSI=${rsi.toFixed(1)}, Vol=${volumeRatio.toFixed(2)}x`);
            }

            if (strongBuyCondition) {
                console.log(`✅ STRONG BUY: Bullish trend + volume confirmation`);
                this.tradeCount++;
                this.lastSignal = 'BUY';
                if (!this.isBacktest) this.recordEntry(symbol);
                return { 
                    signal: 'BUY', 
                    reason: `Strong bullish trend with volume`,
                    price: currentPrice 
                };
            }

            if (strongSellCondition) {
                console.log(`✅ STRONG SELL: Bearish trend + volume confirmation`);
                this.tradeCount++;
                this.lastSignal = 'SELL';
                if (!this.isBacktest) this.recordEntry(symbol);
                return { 
                    signal: 'SELL', 
                    reason: `Strong bearish trend with volume`,
                    price: currentPrice 
                };
            }

            return { signal: 'HOLD', reason: 'No quality setup', price: currentPrice };

        } catch (error) {
            console.error(`Strategy error:`, error.message);
            return { signal: 'HOLD', reason: 'Error', price: 0 };
        }
    }

    getTrendStrength(closes, ema20, ema50) {
        const price = closes[closes.length - 1];
        const prevPrice = closes[closes.length - 2];
        
        // Strong bullish: Price above both EMAs + EMAs aligned up + price rising
        if (price > ema20 && ema20 > ema50 && price > prevPrice) {
            return 'strong_bullish';
        }
        
        // Strong bearish: Price below both EMAs + EMAs aligned down + price falling
        if (price < ema20 && ema20 < ema50 && price < prevPrice) {
            return 'strong_bearish';
        }
        
        // Weak bullish: Mixed but generally up
        if (price > ema20 && ema20 > ema50 * 0.998) {
            return 'weak_bullish';
        }
        
        // Weak bearish: Mixed but generally down
        if (price < ema20 && ema20 < ema50 * 1.002) {
            return 'weak_bearish';
        }
        
        return 'ranging';
    }

    isBullishCandle(candle) {
        return candle.close > candle.open && (candle.close - candle.open) > (candle.high - candle.low) * 0.3;
    }

    isBearishCandle(candle) {
        return candle.close < candle.open && (candle.open - candle.close) > (candle.high - candle.low) * 0.3;
    }

    calculateLevels(entryPrice, side) {
        // 🎯 BETTER RISK/REWARD FOR 15M VOLATILITY
        const riskPercent = 0.50;     // 0.50% stop loss (wider for 15m)
        const rewardPercent = 1.00;   // 1.00% take profit (2:1 ratio)
        
        console.log(`🎯 Improved: ${riskPercent}% SL, ${rewardPercent}% TP`);

        if (side === 'BUY') {
            return {
                stopLoss: entryPrice * (1 - riskPercent / 100),
                takeProfit: entryPrice * (1 + rewardPercent / 100)
            };
        } else {
            return {
                stopLoss: entryPrice * (1 + riskPercent / 100),
                takeProfit: entryPrice * (1 - rewardPercent / 100)
            };
        }
    }

    calculatePositionSize(accountBalance, price) {
        const riskPercent = 0.02; // 2% risk per trade
        const stopLossPercent = 0.50; // 0.50% stop loss
        
        const riskAmount = accountBalance * riskPercent;
        const priceRisk = price * (stopLossPercent / 100);
        const quantity = riskAmount / priceRisk;
        
        console.log(`💰 Better Sizing: $${riskAmount.toFixed(2)} risk = ${quantity.toFixed(6)} coins`);
        return quantity;
    }

    hasActivePosition(symbol) {
        if (this.isBacktest) return false;
        return this.positions.has(symbol);
    }

    recordEntry(symbol) {
        this.positions.set(symbol, {
            entryTime: Date.now(),
            symbol: symbol
        });
    }

    recordExit(symbol) {
        this.positions.delete(symbol);
    }

    setBacktestMode(isBacktest) {
        this.isBacktest = isBacktest;
    }
}

module.exports = SimpleScalpingStrategy;