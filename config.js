require('dotenv').config();

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

risk: {
    stopLossPercent: 0.50,     // 0.50% stop loss (wider for 15m)
    takeProfitPercent: 1.00,   // 1.00% take profit (2:1 ratio)
    maxDailyLoss: 100,         // Higher for testing
},

trading: {
    symbols: ['BTCUSDT'],
    leverage: 3,
    positionPercent: 2.0,      // 2% risk per trade
    minPositionValue: 20,
    maxPositionSize: 500,
    maxOpenPositions: 1,
    marginMode: 'ISOLATED'
},

strategy: {
    name: 'simple_scalping',
    timeframe: '15m',
    minTimeBetweenTrades: 60 * 60 * 1000,  // 1 hour between trades for quality
    maxHoldTime: 8 * 60 * 60 * 1000        // Max 8 hours hold time
}

};

config.getCurrentConfig = function () {
    return this.binance[this.environment];
};

config.validate = function () {
    const currentConfig = this.getCurrentConfig();
    if (!currentConfig.apiKey || !currentConfig.secretKey) {
        throw new Error(`Missing API keys for ${this.environment}`);
    }
    return true;
};

module.exports = config;