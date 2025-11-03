const EmaCrossoverStrategy = require('./emaCrossover');
const RsiStrategy = require('./rsiStrategy');
const MacdStrategy = require('./macdStrategy');
const ScalpingStrategy = require('./scalpingStrategy'); // ✅ Add this
const AdvancedScalpingStrategy = require('./advancedScalping');
const MomentumScalpingStrategy = require('./momentumScalping');

class StrategyFactory {
    static createStrategy(strategyName, config) {
        switch (strategyName) {
            case 'ema_crossover':
                return new EmaCrossoverStrategy(config);
            case 'rsi':
                return new RsiStrategy(config);
            case 'macd':
                return new MacdStrategy(config);
            case 'scalping': // ✅ Add this
                return new ScalpingStrategy(config);
            case 'advanced_scalping':
                return new AdvancedScalpingStrategy(config);
            case 'momentum_scalping':
                return new MomentumScalpingStrategy(config);
            default:
                throw new Error(`Unknown strategy: ${strategyName}`);
        }
    }
}

module.exports = StrategyFactory;