// config/strategies/simpleScalping.js
const pairConfigs = {
    'BTCUSDT': {
        name: 'BTCUSDT',
        enabled: true,
        risk: {
            stopLossPercent: 0.50,
            takeProfitPercent: 1.00,
            positionPercent: 2.0
        },
        filters: {
            minVolume: 1.2,
            minATR: 0.3,
            minRSI: 48,
            maxRSI: 65,
            minVolumeShort: 1.4,
            priceMovementThreshold: 0.005
        },
        indicators: {
            emaPeriods: [20, 50],
            rsiPeriod: 14,
            atrPeriod: 14
        },
        conditions: {
            trendStrength: 'strong_bullish',
            volumeConfirmation: true,
            candleConfirmation: true
        }
    },
    'BNBUSDT': {
        name: 'BNBUSDT',
        enabled: true,
        risk: {
            stopLossPercent: 0.50,
            takeProfitPercent: 1.00,
            positionPercent: 2.0
        },
        filters: {
            minVolume: 1.2,
            minATR: 0.3,
            minRSI: 48,
            maxRSI: 65,
            minVolumeShort: 1.4,
            priceMovementThreshold: 0.005
        },
        indicators: {
            emaPeriods: [20, 50],
            rsiPeriod: 14,
            atrPeriod: 14
        }
    },
    'ETHUSDT': {
        name: 'ETHUSDT',
        enabled: true,
        risk: {
            stopLossPercent: 0.50,
            takeProfitPercent: 1.00,
            positionPercent: 2.0
        },
        filters: {
            minVolume: 1.3,
            minATR: 0.4,
            minRSI: 50,
            maxRSI: 68,
            minVolumeShort: 1.5,
            priceMovementThreshold: 0.008
        },
        indicators: {
            emaPeriods: [20, 50],
            rsiPeriod: 14,
            atrPeriod: 14
        }
    },
    'XRPUSDT': {
        name: 'XRPUSDT',
        enabled: true,
        risk: {
            stopLossPercent: 0.50,
            takeProfitPercent: 1.00,
            positionPercent: 2.0
        },
        filters: {
            minVolume: 1.3,
            minATR: 0.4,
            minRSI: 50,
            maxRSI: 68,
            minVolumeShort: 1.5,
            priceMovementThreshold: 0.008
        },
        indicators: {
            emaPeriods: [20, 50],
            rsiPeriod: 14,
            atrPeriod: 14
        }
    },
    'ADAUSDT': {
        name: 'ADAUSDT',
        enabled: true,
        risk: {
            stopLossPercent: 0.50,
            takeProfitPercent: 1.00,
            positionPercent: 2.0
        },
        filters: {
            minVolume: 1.3,
            minATR: 0.4,
            minRSI: 50,
            maxRSI: 68,
            minVolumeShort: 1.5,
            priceMovementThreshold: 0.008
        },
        indicators: {
            emaPeriods: [20, 50],
            rsiPeriod: 14,
            atrPeriod: 14
        }
    }
};

module.exports = pairConfigs;