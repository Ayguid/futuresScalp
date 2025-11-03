require('dotenv').config();

const config = {
    // Environment: 'testnet' or 'mainnet'
    environment: process.env.BOT_ENVIRONMENT || 'testnet',
    // API Configuration
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

    // Trading Configuration - OPTIMIZED FOR SCALPING
    trading: {
        symbols: ['BTCUSDT', 'ETHUSDT','DOGEUSDT'], // Focus on most liquid pairs for scalping
        leverage: 10,                    // Higher leverage for smaller moves
        maxPositionSize: 200, 
        maxOpenPositions: 4,             // More concurrent positions for scalping
        positionPercent: 1,              // Smaller positions (1% instead of 2%)
        minPositionValue: 50,             // Lower minimum for more frequent trades
        marginMode: 'ISOLATED'           // 🆕 ADD THIS LINE - 'ISOLATED' or 'CROSSED'
    },

    // Risk Management - TIGHTER FOR SCALPING
    risk: {
        maxDailyLoss: 30,                // Lower daily loss limit
        stopLossPercent: 0.8,            // Tighter stop loss (0.8%)
        takeProfitPercent: 1.5,          // Lower take profit (1.5%)
        trailingStopPercent: 0.3,        // Tighter trailing stop
    },

    // Strategy Configuration - PERFECTLY MATCHED WITH YOUR STRATEGY
    strategy: {
        name: 'advanced_scalping',
        timeframe: '1m',                 // Fast timeframe for scalping
        
        // EMA Parameters - FAST for scalping
        fastEMA: 3,
        slowEMA: 8,
        
        // RSI Parameters - EXTREME for scalping
        rsiPeriod: 10,
        rsiOversold: 25,
        rsiOverbought: 75,
        
        // Volume & Momentum
        volumeThreshold: 0.8,
        momentumThreshold: 0.05,
        maxHoldTime: 300,                // 5 minutes max hold
        
        // MACD is hardcoded in strategy (8,21,5) - perfect for scalping
    }
};

// Get current environment config
config.getCurrentConfig = function () {
    return this.binance[this.environment];
};

// Validate configuration
config.validate = function () {
    const currentConfig = this.getCurrentConfig();
    if (!currentConfig.apiKey || !currentConfig.secretKey) {
        throw new Error(`Missing API keys for ${this.environment}`);
    }
    return true;
};

module.exports = config;