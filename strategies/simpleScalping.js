// strategies/simpleScalping.js
const BaseStrategy = require('./baseStrategy');
const Indicators = require('../indicators');

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

            // Trend detection
            const trendStrength = this.getTrendStrength(closes, ema20, ema50);
            const atrPercentage = (atr / currentPrice) * 100;

            // Symbol-specific filters
            const symbolConfig = this.getSymbolConfig(symbol);

            if (volumeRatio < symbolConfig.filters.minVolume) {
                return { signal: 'HOLD', reason: 'Low volume' };
            }

            if (atrPercentage < symbolConfig.filters.minATR) {
                return { signal: 'HOLD', reason: 'Low volatility' };
            }

            // Entry conditions
            const entryConditions = this.getEntryConditions(symbolConfig, trendStrength, currentPrice, ema20, rsi, volumeRatio, currentLow, currentHigh, currentCandle);

            if (entryConditions.buyCondition || entryConditions.sellCondition) {
                console.log(`\n🎯 ${symbol} SETUP: Trend=${trendStrength}, RSI=${rsi.toFixed(1)}, Vol=${volumeRatio.toFixed(2)}x`);
            }

            if (entryConditions.buyCondition) {
                console.log(`✅ ${symbol} BUY: Bullish trend + volume confirmation`);
                this.tradeCount++;
                return {
                    signal: 'BUY',
                    reason: `Bullish trend with volume`,
                    price: currentPrice
                };
            }

            if (entryConditions.sellCondition) {
                console.log(`✅ ${symbol} SELL: Bearish trend + volume confirmation`);
                this.tradeCount++;
                return {
                    signal: 'SELL',
                    reason: `Bearish trend with volume`,
                    price: currentPrice
                };
            }

            return { signal: 'HOLD', reason: 'No quality setup', price: currentPrice };

        } catch (error) {
            console.error(`Strategy error:`, error.message);
            return { signal: 'HOLD', reason: 'Error', price: 0 };
        }
    }

    getSymbolConfig(symbol) {
        // 🎯 ALL MAGIC NUMBERS IN ONE PLACE
        const configs = {
            // BTCUSDT - EXCELLENT (17.73% return, 53.8% win rate)
            'BTCUSDT': {
                filters: {
                    minVolume: 1.2,
                    minATR: 0.3
                },
                risk: { 
                    stopLossPercent: 0.50, 
                    takeProfitPercent: 1.00 
                },
                entryConditions: {
                    buy: {
                        minRSI: 48,
                        maxRSI: 65,
                        minVolume: 1.4,
                        priceMovement: 1.005
                    },
                    sell: {
                        minRSI: 35,
                        maxRSI: 52,
                        minVolume: 1.4,
                        priceMovement: 0.995
                    }
                }
            },
            // BNBUSDT - EXCELLENT (39.41% return, 48.1% win rate)  
            'BNBUSDT': {
                filters: {
                    minVolume: 1.2,
                    minATR: 0.3
                },
                risk: { 
                    stopLossPercent: 0.50, 
                    takeProfitPercent: 1.00 
                },
                entryConditions: {
                    buy: {
                        minRSI: 48,
                        maxRSI: 65,
                        minVolume: 1.4,
                        priceMovement: 1.005
                    },
                    sell: {
                        minRSI: 35,
                        maxRSI: 52,
                        minVolume: 1.4,
                        priceMovement: 0.995
                    }
                }
            },
            // ETHUSDT - EXCELLENT (51.57% return, 60% win rate)
            'ETHUSDT': {
                filters: {
                    minVolume: 1.3,
                    minATR: 0.4
                },
                risk: { 
                    stopLossPercent: 0.50, 
                    takeProfitPercent: 1.00 
                },
                entryConditions: {
                    buy: {
                        minRSI: 50,
                        maxRSI: 68,
                        minVolume: 1.5,
                        priceMovement: 1.008
                    },
                    sell: {
                        minRSI: 30,
                        maxRSI: 50,
                        minVolume: 1.5,
                        priceMovement: 0.992
                    }
                }
            },
            // XRPUSDT - GOOD (2.61% return, 47.4% win rate)
            'XRPUSDT': {
                filters: {
                    minVolume: 1.3,
                    minATR: 0.4
                },
                risk: { 
                    stopLossPercent: 0.50, 
                    takeProfitPercent: 1.00 
                },
                entryConditions: {
                    buy: {
                        minRSI: 50,
                        maxRSI: 68,
                        minVolume: 1.5,
                        priceMovement: 1.008
                    },
                    sell: {
                        minRSI: 30,
                        maxRSI: 50,
                        minVolume: 1.5,
                        priceMovement: 0.992
                    }
                }
            },
            // ADAUSDT - NEEDS FIX (-56% return)
            'ADAUSDT': {
                filters: {
                    minVolume: 1.3,
                    minATR: 0.4
                },
                risk: { 
                    stopLossPercent: 0.50, 
                    takeProfitPercent: 1.00 
                },
                entryConditions: {
                    buy: {
                        minRSI: 50,
                        maxRSI: 68,
                        minVolume: 1.5,
                        priceMovement: 1.008
                    },
                    sell: {
                        minRSI: 30,
                        maxRSI: 50,
                        minVolume: 1.5,
                        priceMovement: 0.992
                    }
                }
            },
            // 🎯 ADD NEW SYMBOLS HERE
            'SOLUSDT': {
                filters: {
                    minVolume: 1.4,
                    minATR: 0.6
                },
                risk: { 
                    stopLossPercent: 0.75, 
                    takeProfitPercent: 1.50 
                },
                entryConditions: {
                    buy: {
                        minRSI: 45,
                        maxRSI: 70,
                        minVolume: 1.6,
                        priceMovement: 1.010
                    },
                    sell: {
                        minRSI: 25,
                        maxRSI: 55,
                        minVolume: 1.6,
                        priceMovement: 0.990
                    }
                }
            },
            'DOGEUSDT': {
                filters: {
                    minVolume: 1.5,
                    minATR: 0.7
                },
                risk: { 
                    stopLossPercent: 0.80, 
                    takeProfitPercent: 1.60 
                },
                entryConditions: {
                    buy: {
                        minRSI: 40,
                        maxRSI: 72,
                        minVolume: 1.7,
                        priceMovement: 1.012
                    },
                    sell: {
                        minRSI: 20,
                        maxRSI: 58,
                        minVolume: 1.7,
                        priceMovement: 0.988
                    }
                }
            }
        };

        return configs[symbol] || {
            filters: {
                minVolume: 1.2,
                minATR: 0.3
            },
            risk: { 
                stopLossPercent: 0.50, 
                takeProfitPercent: 1.00 
            },
            entryConditions: {
                buy: {
                    minRSI: 50,
                    maxRSI: 65,
                    minVolume: 1.4,
                    priceMovement: 1.006
                },
                sell: {
                    minRSI: 35,
                    maxRSI: 50,
                    minVolume: 1.4,
                    priceMovement: 0.994
                }
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

    calculateLevels(entryPrice, side, symbol = '') {
        // 🎯 USE PAIR-SPECIFIC RISK FROM STRATEGY CONFIG
        const symbolConfig = this.getSymbolConfig(symbol);
        const riskPercent = symbolConfig.risk.stopLossPercent;
        const rewardPercent = symbolConfig.risk.takeProfitPercent;

        console.log(`🎯 ${symbol} Risk: ${riskPercent}% SL, ${rewardPercent}% TP`);

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

    calculatePositionSize(accountBalance, price, symbol = '') {
        const riskPercent = this.config?.trading?.positionPercent / 100 || 0.02;
        const leverage = this.config?.trading?.leverage || 1;

        // 🎯 USE PAIR-SPECIFIC RISK FROM STRATEGY CONFIG
        const symbolConfig = this.getSymbolFilters(symbol);
        const stopLossPercent = symbolConfig.risk.stopLossPercent;

        const riskAmount = accountBalance * riskPercent;
        const priceRisk = price * (stopLossPercent / 100);

        const unleveragedQuantity = riskAmount / priceRisk;

        console.log(`💰 ${symbol} Position Sizing:`);
        console.log(`   Account: $${accountBalance.toFixed(2)}`);
        console.log(`   Risk: ${(riskPercent * 100).toFixed(1)}% = $${riskAmount.toFixed(2)}`);
        console.log(`   Stop Loss: ${stopLossPercent}% (Pair Specific)`);
        console.log(`   Leverage: ${leverage}x`);
        console.log(`   Quantity: ${unleveragedQuantity.toFixed(6)} coins`);

        return unleveragedQuantity;
    }
}

module.exports = SimpleScalpingStrategy;