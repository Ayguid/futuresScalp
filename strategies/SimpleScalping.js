import BaseStrategy from '#strategies/BaseStrategy';
import Indicators from '#utils/indicators';

class SimpleScalpingStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.config = config;
        this.name = 'simple_scalping';
        console.log('🎯 STRATEGY - Using centralized config');
    }

    analyze(data, symbol = '') {
        try {
            if (data.length < 100) return {
                signal: 'HOLD',
                reason: 'Insufficient data',
                indicators: {}
            };

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
                return {
                    signal: 'HOLD',
                    reason: 'Indicators not ready',
                    indicators: {}
                };
            }

            // Volume analysis
            const volumeAvg = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            const volumeRatio = currentVolume / volumeAvg;

            // Trend detection
            const trendStrength = this.getTrendStrength(closes, ema20, ema50);
            const atrPercentage = (atr / currentPrice) * 100;

            // ✅ USE CONFIG METHOD INSTEAD OF LOCAL METHOD
            const symbolConfig = this.config.getSymbolConfig(symbol);

            // Build indicators object for return
            const indicators = {
                trendStrength,
                ema20,
                ema50,
                rsi,
                atr,
                atrPercentage,
                volumeRatio,
                volumeAvg,
                currentPrice,
                currentVolume
            };

            if (volumeRatio < symbolConfig.filters.minVolume) {
                return {
                    signal: 'HOLD',
                    reason: 'Low volume',
                    indicators: indicators
                };
            }

            if (atrPercentage < symbolConfig.filters.minATR) {
                return {
                    signal: 'HOLD',
                    reason: 'Low volatility',
                    indicators: indicators
                };
            }

            // Entry conditions
            const entryConditions = this.getEntryConditions(
                symbolConfig,
                trendStrength,
                currentPrice,
                ema20,
                rsi,
                volumeRatio,
                currentLow,
                currentHigh,
                currentCandle
            );

            if (entryConditions.buyCondition || entryConditions.sellCondition) {
                console.log(`\n🎯 ${symbol} SETUP: Trend=${trendStrength}, RSI=${rsi.toFixed(1)}, Vol=${volumeRatio.toFixed(2)}x`);
            }

            if (entryConditions.buyCondition) {
                console.log(`✅ ${symbol} BUY: Bullish trend + volume confirmation`);
                return {
                    signal: 'BUY',
                    reason: `Bullish trend with volume`,
                    price: currentPrice,
                    indicators: indicators
                };
            }

            if (entryConditions.sellCondition) {
                console.log(`✅ ${symbol} SELL: Bearish trend + volume confirmation`);
                return {
                    signal: 'SELL',
                    reason: `Bearish trend with volume`,
                    price: currentPrice,
                    indicators: indicators
                };
            }

            return {
                signal: 'HOLD',
                reason: 'No quality setup',
                price: currentPrice,
                indicators: indicators
            };
        } catch (error) {
            console.error(`Strategy error:`, error.message);
            return {
                signal: 'HOLD',
                reason: 'Error',
                price: 0,
                indicators: {}
            };
        }
    }

    getEntryConditions(symbolConfig, trendStrength, currentPrice, ema20, rsi, volumeRatio, currentLow, currentHigh, currentCandle) {
        const { buy: buyConditions, sell: sellConditions } = symbolConfig.entryConditions;

        return {
            buyCondition:
                trendStrength === 'strong_bullish' &&
                currentPrice > ema20 &&
                rsi > buyConditions.minRSI && rsi < buyConditions.maxRSI &&
                volumeRatio > buyConditions.minVolume &&
                currentPrice > currentLow * buyConditions.priceMovement &&
                this.isBullishCandle(currentCandle),

            sellCondition:
                trendStrength === 'strong_bearish' &&
                currentPrice < ema20 &&
                rsi > sellConditions.minRSI && rsi < sellConditions.maxRSI &&
                volumeRatio > sellConditions.minVolume &&
                currentPrice < currentHigh * sellConditions.priceMovement &&
                this.isBearishCandle(currentCandle)
        };
    }

    getTrendStrength(closes, ema20, ema50) {
        const price = closes[closes.length - 1];
        const prevPrice = closes[closes.length - 2];

        if (price > ema20 && ema20 > ema50 && price > prevPrice) {
            return 'strong_bullish';
        }

        if (price < ema20 && ema20 < ema50 && price < prevPrice) {
            return 'strong_bearish';
        }

        return 'ranging';
    }

    isBullishCandle(candle) {
        return candle.close > candle.open &&
            (candle.close - candle.open) > (candle.high - candle.low) * 0.3;
    }

    isBearishCandle(candle) {
        return candle.close < candle.open &&
            (candle.open - candle.close) > (candle.high - candle.low) * 0.3;
    }

calculateLevels(entryPrice, side, symbol = '', indicators = {}) {
    // USE CONFIG METHOD
    const symbolConfig = this.config.getSymbolConfig(symbol);
    let takeProfitPercent = symbolConfig.risk.takeProfitPercent;

    // USE CONFIG VALUE
    takeProfitPercent *= this.config.strategy.tpAdjustmentFactor;

    let stopLoss, takeProfit;

    // ATR-BASED STOPS (if ATR data available)
    if (indicators.atr && indicators.currentPrice) {
        const useWiderStops = this.config.trading.stopMode === 'wide';
        const atrMultiplier = useWiderStops ? 1.5 : 1.0;

        const stopLossDistance = indicators.atr * atrMultiplier;
        const stopLossPercentActual = (stopLossDistance / entryPrice) * 100;

        // ✅ FIXED: Calculate RR ratio from config to match percentage stops
        const configRR = takeProfitPercent / symbolConfig.risk.stopLossPercent;
        
        if (side === 'BUY') {
            stopLoss = entryPrice - stopLossDistance;
            takeProfit = entryPrice + (stopLossDistance * configRR); // Use config ratio
        } else {
            stopLoss = entryPrice + stopLossDistance;
            takeProfit = entryPrice - (stopLossDistance * configRR); // Use config ratio
        }

        console.log(`🎯 ${symbol}: ATR-based ${useWiderStops ? 'WIDE' : 'TIGHT'} | SL: ${stopLossPercentActual.toFixed(2)}% | R:R 1:${configRR.toFixed(1)} | ATR: ${indicators.atr.toFixed(4)}`);

    } else {
        // FALLBACK TO PERCENTAGE-BASED STOPS (unchanged)
        const stopLossPercent = symbolConfig.risk.stopLossPercent;

        if (side === 'BUY') {
            stopLoss = entryPrice * (1 - stopLossPercent / 100);
            takeProfit = entryPrice * (1 + takeProfitPercent / 100);
        } else {
            stopLoss = entryPrice * (1 + stopLossPercent / 100);
            takeProfit = entryPrice * (1 - takeProfitPercent / 100);
        }

        const actualRR = (takeProfitPercent / stopLossPercent).toFixed(1);
        console.log(`🐢 ${symbol}: Percentage-based | R:R 1:${actualRR} | TP: ${takeProfitPercent.toFixed(2)}%`);
    }

    return { stopLoss, takeProfit };
}

    calculatePositionSize(accountBalance, price, symbol = '') {
        // USE CONFIG METHOD
        const symbolConfig = this.config.getSymbolConfig(symbol);
        const riskPercent = this.config.trading.positionPercent / 100;
        const stopLossPercent = symbolConfig.risk.stopLossPercent;

        // USE CONFIG VALUE
        const sizeFactor = this.config.strategy.sizeMultiplier;

        const riskAmount = accountBalance * riskPercent * sizeFactor;
        const priceRisk = price * (stopLossPercent / 100);
        const unleveragedQuantity = riskAmount / priceRisk;

        console.log(`💰 ${symbol}: ${unleveragedQuantity.toFixed(6)} coins (${sizeFactor}x size)`);

        return unleveragedQuantity;
    }
}

export default SimpleScalpingStrategy;