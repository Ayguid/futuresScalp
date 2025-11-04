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

    trading: {
        symbols: ['BTCUSDT', 'BNBUSDT', 'ETHUSDT', 'XRPUSDT'], // ,'ADAUSDT' -26.23%
        leverage: 4,
        positionPercent: 0.5,      //% risk per trade
        minPositionValue: 10,
        maxPositionSize: 500,
        maxOpenPositions: 3,
        marginMode: 'ISOLATED'
    },

    strategy: {
        name: 'simple_scalping',
        timeframe: '15m',
        minTimeBetweenTrades: 60 * 60 * 1000,  // 1 hour between trades
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