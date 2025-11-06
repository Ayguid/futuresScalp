class BaseStrategy {
    constructor(config) {
        this.config = config;
        this.name = 'base';
    }

    analyze(data) {
        throw new Error('analyze method must be implemented by strategy');
    }

    calculatePositionSize(accountBalance, price) {
        const positionPercent = this.config.trading.positionPercent || 2;
        const positionValue = accountBalance * (positionPercent / 100);
        
        let quantity = positionValue / price;
        
        const minPositionValue = this.config.trading.minPositionValue || 110;
        if (positionValue < minPositionValue) {
            quantity = minPositionValue / price;
        }
        
        const maxQuantity = this.config.trading.maxPositionSize / price;
        return Math.min(quantity, maxQuantity);
    }

    calculateLevels(entryPrice, side) {
        const stopLossPercent = this.config.risk.stopLossPercent;
        const takeProfitPercent = this.config.risk.takeProfitPercent;
        
        if (side === 'BUY') {
            return {
                stopLoss: entryPrice * (1 - stopLossPercent / 100),
                takeProfit: entryPrice * (1 + takeProfitPercent / 100)
            };
        } else {
            return {
                stopLoss: entryPrice * (1 + stopLossPercent / 100),
                takeProfit: entryPrice * (1 - takeProfitPercent / 100)
            };
        }
    }
}

export default BaseStrategy;