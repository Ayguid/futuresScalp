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

    trading: {
        symbols: ['BTCUSDT', 'BNBUSDT', 'ETHUSDT', 'XRPUSDT'], // ,'ADAUSDT' -26.23%
        leverage: 4,
        positionPercent: 0.5,      //% risk per trade
        maxOpenPositions: 3,
        marginMode: 'ISOLATED'
    },

    strategy: {
        name: 'simple_scalping',
        timeframe: '15m',
        minTimeBetweenTrades: 60 * 60 * 1000,  // 1 hour between trades
        maxHoldTime: 8 * 60 * 60 * 1000        // Max 8 hours hold time
    },

    safety: {
        // Testnet-specific settings
        testnet: {
            continuousMonitoring: true,
            orphanCheckFrequency: 1.0, // Check every cycle
            emergencyRepair: true,
            verificationDelay: 3000
        },
        // Mainnet settings  
        mainnet: {
            continuousMonitoring: false,
            orphanCheckFrequency: 0.05, // 5% chance - very rare
            emergencyRepair: false, // Never auto-repair in mainnet
            verificationDelay: 1500
        }
    }
};

config.getCurrentConfig = function () {
    return this.binance[this.environment];
};

// 🛡️ GET SAFETY SETTINGS BASED ON ENVIRONMENT
config.getSafetyConfig = function () {
    const isMainnet = this.environment === 'mainnet';
    return {
        verificationDelay: isMainnet ? 1500 : 3000,
        maxRetries: isMainnet ? 2 : 3,
        emergencyTimeout: 10000,
        ...this.safety
    };
};

config.validate = function () {
    const currentConfig = this.getCurrentConfig();
    if (!currentConfig.apiKey || !currentConfig.secretKey) {
        throw new Error(`Missing API keys for ${this.environment}`);
    }
    return true;
};

export default config;