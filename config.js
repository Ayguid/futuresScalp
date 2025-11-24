import 'dotenv/config';

const config = {
    environment: process.env.BOT_ENVIRONMENT || 'testnet',

    binance: {
        testnet: {
            apiKey: process.env.BINANCE_TESTNET_API_KEY,
            secretKey: process.env.BINANCE_TESTNET_SECRET_KEY,
            baseURL: 'https://demo-fapi.binance.com',
            websocketURL: 'wss://stream.binancefuture.com'
        },
        mainnet: {
            apiKey: process.env.BINANCE_MAINNET_API_KEY,
            secretKey: process.env.BINANCE_MAINNET_SECRET_KEY,
            baseURL: 'https://fapi.binance.com',
            websocketURL: 'wss://fstream.binance.com'
        }
    },

    strategy: {
        name: 'simple_scalping',
        timeframe: '15m',
        sizeMultiplier: 1.2,      // 20% position size increase
        tpAdjustmentFactor: 0.9,  // Take Profit adjustment (0.9 = 10% reduction, 1.1 = 10% increase)
    },

    trading: {
        symbols: ['BTCUSDT', 'BNBUSDT', 'ETHUSDT', 'XRPUSDT'],
        leverage: 4,
        positionPercent: 0.5,
        maxOpenPositions: 3,
        marginMode: 'ISOLATED',
        stopMode: 'tight', // 'tight' or 'wide'
        cooldowns: { afterOpen: 300, afterClose: 600},
        symbolConfigs: {
            'BTCUSDT': {
                filters: { minVolume: 1.2, minATR: 0.3 },
                risk: {
                    stopLossPercent: { tight: 0.50, wide: 0.80 },
                    takeProfitPercent: { tight: 1.00, wide: 1.60 }
                },
                entryConditions: {
                    buy: { minRSI: 48, maxRSI: 65, minVolume: 1.4, priceMovement: 1.005 },
                    sell: { minRSI: 35, maxRSI: 52, minVolume: 1.4, priceMovement: 0.995 }
                }
            },
            'BNBUSDT': {
                filters: { minVolume: 1.2, minATR: 0.3 },
                risk: {
                    stopLossPercent: { tight: 0.50, wide: 0.80 },
                    takeProfitPercent: { tight: 1.00, wide: 1.60 }
                },
                entryConditions: {
                    buy: { minRSI: 48, maxRSI: 65, minVolume: 1.4, priceMovement: 1.005 },
                    sell: { minRSI: 35, maxRSI: 52, minVolume: 1.4, priceMovement: 0.995 }
                }
            },
            'ETHUSDT': {
                filters: { minVolume: 1.3, minATR: 0.4 },
                risk: {
                    stopLossPercent: { tight: 0.50, wide: 0.80 },
                    takeProfitPercent: { tight: 1.00, wide: 1.60 }
                },
                entryConditions: {
                    buy: { minRSI: 50, maxRSI: 68, minVolume: 1.5, priceMovement: 1.008 },
                    sell: { minRSI: 30, maxRSI: 50, minVolume: 1.5, priceMovement: 0.992 }
                }
            },
            'XRPUSDT': {
                filters: { minVolume: 1.3, minATR: 0.4 },
                risk: {
                    stopLossPercent: { tight: 0.50, wide: 0.80 },
                    takeProfitPercent: { tight: 1.00, wide: 1.60 }
                },
                entryConditions: {
                    buy: { minRSI: 50, maxRSI: 68, minVolume: 1.5, priceMovement: 1.008 },
                    sell: { minRSI: 30, maxRSI: 50, minVolume: 1.5, priceMovement: 0.992 }
                }
            },
            'ADAUSDT': {
                filters: { minVolume: 1.3, minATR: 0.4 },
                risk: {
                    stopLossPercent: { tight: 0.50, wide: 0.80 },
                    takeProfitPercent: { tight: 1.00, wide: 1.60 }
                },
                entryConditions: {
                    buy: { minRSI: 50, maxRSI: 68, minVolume: 1.5, priceMovement: 1.008 },
                    sell: { minRSI: 30, maxRSI: 50, minVolume: 1.5, priceMovement: 0.992 }
                }
            },
            'SOLUSDT': {
                filters: { minVolume: 1.4, minATR: 0.6 },
                risk: {
                    stopLossPercent: { tight: 0.75, wide: 1.20 },
                    takeProfitPercent: { tight: 1.50, wide: 2.40 }
                },
                entryConditions: {
                    buy: { minRSI: 45, maxRSI: 70, minVolume: 1.6, priceMovement: 1.010 },
                    sell: { minRSI: 25, maxRSI: 55, minVolume: 1.6, priceMovement: 0.990 }
                }
            },
            'DOGEUSDT': {
                filters: { minVolume: 1.5, minATR: 0.7 },
                risk: {
                    stopLossPercent: { tight: 0.80, wide: 1.28 },
                    takeProfitPercent: { tight: 1.60, wide: 2.56 }
                },
                entryConditions: {
                    buy: { minRSI: 40, maxRSI: 72, minVolume: 1.7, priceMovement: 1.012 },
                    sell: { minRSI: 20, maxRSI: 58, minVolume: 1.7, priceMovement: 0.988 }
                }
            }
        },
        
        // DEFAULT CONFIG FOR UNCONFIGURED SYMBOLS
        defaultSymbolConfig: {
            filters: { minVolume: 1.2, minATR: 0.3 },
            risk: {
                stopLossPercent: { tight: 0.50, wide: 0.80 },
                takeProfitPercent: { tight: 1.00, wide: 1.60 }
            },
            entryConditions: {
                buy: { minRSI: 50, maxRSI: 65, minVolume: 1.4, priceMovement: 1.006 },
                sell: { minRSI: 35, maxRSI: 50, minVolume: 1.4, priceMovement: 0.994 }
            }
        }
    },
    safety: {//removed, will be used later
        testnet: {
            continuousMonitoring: true,
            emergencyRepair: true,
            verificationDelay: 3000
        },
        mainnet: {
            continuousMonitoring: false,
            emergencyRepair: false,
            verificationDelay: 1500
        }
    }
};

// Get symbol config based on current stopMode
config.getSymbolConfig = function(symbol) {
    const symbolConfig = this.trading.symbolConfigs[symbol] || this.trading.defaultSymbolConfig;
    const stopMode = this.trading.stopMode || 'tight';
    
    return {
        ...symbolConfig,
        risk: {
            stopLossPercent: symbolConfig.risk.stopLossPercent[stopMode],
            takeProfitPercent: symbolConfig.risk.takeProfitPercent[stopMode]
        }
    };
};

config.getCurrentConfig = function () {
    return this.binance[this.environment];
};

config.getSafetyConfig = function () {
    const env = this.environment; // 'testnet' or 'mainnet'
    return this.safety[env]; // ✅ Actually use the safety config
};

config.validate = function () {
    const currentConfig = this.getCurrentConfig();
    if (!currentConfig.apiKey || !currentConfig.secretKey) {
        throw new Error(`Missing API keys for ${this.environment}`);
    }
    
    // VALIDATE ALL CONFIGURED SYMBOLS EXIST IN TRADING SYMBOLS
    const configuredSymbols = Object.keys(this.trading.symbolConfigs || {});
    const tradingSymbols = this.trading.symbols || [];
    
    const missingSymbols = configuredSymbols.filter(sym => !tradingSymbols.includes(sym));
    if (missingSymbols.length > 0) {
        console.warn(`⚠️ Configured symbols not in trading list: ${missingSymbols.join(', ')}`);
    }
    
    return true;
};

export default config;