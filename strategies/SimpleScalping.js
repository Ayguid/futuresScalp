import BaseStrategy from '#strategies/BaseStrategy';
import Indicators from '#utils/indicators';

class SimpleScalpingStrategy extends BaseStrategy {
    constructor(config) {
        super(config);
        this.config = config;
        this.name = 'simple_scalping';
        this.tradeCount = 0;
        console.log('🎯 FINAL WINNING STRATEGY - ALL CONFIGS INTERNAL');
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

            // Symbol-specific filters
            const symbolConfig = this.getSymbolConfig(symbol);

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
                this.tradeCount++;
                return {
                    signal: 'BUY',
                    reason: `Bullish trend with volume`,
                    price: currentPrice,
                    indicators: indicators
                };
            }

            if (entryConditions.sellCondition) {
                console.log(`✅ ${symbol} SELL: Bearish trend + volume confirmation`);
                this.tradeCount++;
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

    getSymbolConfig(symbol) {
        const useWiderStops = this.config.trading.stopMode === 'wide';

        const configs = {
            'BTCUSDT': {
                filters: { minVolume: 1.2, minATR: 0.3 },
                risk: {
                    stopLossPercent: useWiderStops ? 0.80 : 0.50, // 0.8% live, 0.5% backtest
                    takeProfitPercent: useWiderStops ? 1.60 : 1.00
                },
                entryConditions: {
                    buy: { minRSI: 48, maxRSI: 65, minVolume: 1.4, priceMovement: 1.005 },
                    sell: { minRSI: 35, maxRSI: 52, minVolume: 1.4, priceMovement: 0.995 }
                }
            },
            'BNBUSDT': {
                filters: { minVolume: 1.2, minATR: 0.3 },
                risk: {
                    stopLossPercent: useWiderStops ? 0.80 : 0.50,
                    takeProfitPercent: useWiderStops ? 1.60 : 1.00
                },
                entryConditions: {
                    buy: { minRSI: 48, maxRSI: 65, minVolume: 1.4, priceMovement: 1.005 },
                    sell: { minRSI: 35, maxRSI: 52, minVolume: 1.4, priceMovement: 0.995 }
                }
            },
            'ETHUSDT': {
                filters: { minVolume: 1.3, minATR: 0.4 },
                risk: {
                    stopLossPercent: useWiderStops ? 0.80 : 0.50,
                    takeProfitPercent: useWiderStops ? 1.60 : 1.00
                },
                entryConditions: {
                    buy: { minRSI: 50, maxRSI: 68, minVolume: 1.5, priceMovement: 1.008 },
                    sell: { minRSI: 30, maxRSI: 50, minVolume: 1.5, priceMovement: 0.992 }
                }
            },
            'XRPUSDT': {
                filters: { minVolume: 1.3, minATR: 0.4 },
                risk: {
                    stopLossPercent: useWiderStops ? 0.80 : 0.50,
                    takeProfitPercent: useWiderStops ? 1.60 : 1.00
                },
                entryConditions: {
                    buy: { minRSI: 50, maxRSI: 68, minVolume: 1.5, priceMovement: 1.008 },
                    sell: { minRSI: 30, maxRSI: 50, minVolume: 1.5, priceMovement: 0.992 }
                }
            },
            'ADAUSDT': {
                filters: { minVolume: 1.3, minATR: 0.4 },
                risk: {
                    stopLossPercent: useWiderStops ? 0.80 : 0.50,
                    takeProfitPercent: useWiderStops ? 1.60 : 1.00
                },
                entryConditions: {
                    buy: { minRSI: 50, maxRSI: 68, minVolume: 1.5, priceMovement: 1.008 },
                    sell: { minRSI: 30, maxRSI: 50, minVolume: 1.5, priceMovement: 0.992 }
                }
            },
            'SOLUSDT': {
                filters: { minVolume: 1.4, minATR: 0.6 },
                risk: {
                    stopLossPercent: useWiderStops ? 1.20 : 0.75, // 1.2% live, 0.75% backtest
                    takeProfitPercent: useWiderStops ? 2.40 : 1.50
                },
                entryConditions: {
                    buy: { minRSI: 45, maxRSI: 70, minVolume: 1.6, priceMovement: 1.010 },
                    sell: { minRSI: 25, maxRSI: 55, minVolume: 1.6, priceMovement: 0.990 }
                }
            },
            'DOGEUSDT': {
                filters: { minVolume: 1.5, minATR: 0.7 },
                risk: {
                    stopLossPercent: useWiderStops ? 1.28 : 0.80, // 1.28% live, 0.8% backtest
                    takeProfitPercent: useWiderStops ? 2.56 : 1.60
                },
                entryConditions: {
                    buy: { minRSI: 40, maxRSI: 72, minVolume: 1.7, priceMovement: 1.012 },
                    sell: { minRSI: 20, maxRSI: 58, minVolume: 1.7, priceMovement: 0.988 }
                }
            }
        };

        return configs[symbol] || {
            filters: { minVolume: 1.2, minATR: 0.3 },
            risk: {
                stopLossPercent: useWiderStops ? 0.80 : 0.50,
                takeProfitPercent: useWiderStops ? 1.60 : 1.00
            },
            entryConditions: {
                buy: { minRSI: 50, maxRSI: 65, minVolume: 1.4, priceMovement: 1.006 },
                sell: { minRSI: 35, maxRSI: 50, minVolume: 1.4, priceMovement: 0.994 }
            }
        };
    }

    // 🎯 ADD FOR BACKWARD COMPATIBILITY
    getSymbolFilters(symbol) {
        const config = this.getSymbolConfig(symbol);
        return {
            minVolume: config.filters.minVolume,
            minATR: config.filters.minATR,
            risk: config.risk
        };
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
    /*
    calculateLevels(entryPrice, side, symbol = '') {
        const symbolConfig = this.getSymbolConfig(symbol);
        const stopLossPercent = symbolConfig.risk.stopLossPercent;
        let takeProfitPercent = symbolConfig.risk.takeProfitPercent;

        // 🎯 REPLICATE THE 136% BEHAVIOR: Always tighten TP by 10%
        takeProfitPercent *= 0.9;
        console.log(`🐢 ${symbol}: TP tightened (${takeProfitPercent.toFixed(2)}%)`);

        let stopLoss, takeProfit;
        if (side === 'BUY') {
            stopLoss = entryPrice * (1 - stopLossPercent / 100);
            takeProfit = entryPrice * (1 + takeProfitPercent / 100);
        } else {
            stopLoss = entryPrice * (1 + stopLossPercent / 100);
            takeProfit = entryPrice * (1 - takeProfitPercent / 100);
        }

        return { stopLoss, takeProfit, stopLossPercent, takeProfitPercent };
    }
    */
    calculateLevels(entryPrice, side, symbol = '', indicators = {}) {
        const symbolConfig = this.getSymbolConfig(symbol);
        let takeProfitPercent = symbolConfig.risk.takeProfitPercent;

        // 🎯 REPLICATE THE 136% BEHAVIOR: Always tighten TP by 10%
        takeProfitPercent *= 0.9;

        let stopLoss, takeProfit;

        // ✅ ATR-BASED STOPS (if ATR data available)
        if (indicators.atr && indicators.currentPrice) {
            const useWiderStops = this.config.trading.stopMode === 'wide';
            const atrMultiplier = useWiderStops ? 1.5 : 1.0; // 1.5 ATR for wide, 1.0 ATR for tight

            const stopLossDistance = indicators.atr * atrMultiplier;
            const stopLossPercentActual = (stopLossDistance / entryPrice) * 100;

            if (side === 'BUY') {
                stopLoss = entryPrice - stopLossDistance;
                takeProfit = entryPrice + (stopLossDistance * 2); // 1:2 risk-reward
            } else {
                stopLoss = entryPrice + stopLossDistance;
                takeProfit = entryPrice - (stopLossDistance * 2); // 1:2 risk-reward
            }

            console.log(`🎯 ${symbol}: ATR-based ${useWiderStops ? 'WIDE' : 'TIGHT'} | SL: ${stopLossPercentActual.toFixed(2)}% | ATR: ${indicators.atr.toFixed(4)}`);

        } else {
            // ✅ FALLBACK TO PERCENTAGE-BASED STOPS (original logic)
            const stopLossPercent = symbolConfig.risk.stopLossPercent;

            if (side === 'BUY') {
                stopLoss = entryPrice * (1 - stopLossPercent / 100);
                takeProfit = entryPrice * (1 + takeProfitPercent / 100);
            } else {
                stopLoss = entryPrice * (1 + stopLossPercent / 100);
                takeProfit = entryPrice * (1 - takeProfitPercent / 100);
            }

            console.log(`🐢 ${symbol}: Percentage-based | TP tightened (${takeProfitPercent.toFixed(2)}%)`);
        }

        return { stopLoss, takeProfit };
    }
    calculatePositionSize(accountBalance, price, symbol = '') {
        const riskPercent = this.config?.trading?.positionPercent / 100 || 0.02;
        const symbolConfig = this.getSymbolFilters(symbol);
        const stopLossPercent = symbolConfig.risk.stopLossPercent;

        // 🎯 REPLICATE THE 136% BEHAVIOR: Always increase position by 20%
        const sizeFactor = 1.2;

        const riskAmount = accountBalance * riskPercent * sizeFactor;
        const priceRisk = price * (stopLossPercent / 100);
        const unleveragedQuantity = riskAmount / priceRisk;

        console.log(`💰 ${symbol}: ${unleveragedQuantity.toFixed(6)} coins (1.20x size)`);

        return unleveragedQuantity;
    }

}

export default SimpleScalpingStrategy;