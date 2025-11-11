import BinanceClient from '#bot/BinanceClient';
import StrategyFactory from '#strategies/StrategyFactory';
import Logger from '#utils/Logger';
import config from '#config';

class ScalpingBot {
    constructor() {
        this.client = new BinanceClient();
        this.strategy = StrategyFactory.createStrategy(config.strategy.name, config);
        this.logger = new Logger();

        this.isRunning = false;
        this.positions = new Map();
        this.orders = new Map();
        this.cooldowns = new Map();
        this.pendingOperations = new Map();
        this.safetyConfig = config.getSafetyConfig();

        this.initBot();
    }

    // === INITIALIZATION ===
    initBot() {
        this.logger.info(`Bot Started - ${config.environment.toUpperCase()}`);
        this.logger.info(`Strategy: ${this.strategy.name}`);
        this.logger.info(config.environment === 'testnet'
            ? '🧪 TESTNET MODE: Aggressive monitoring'
            : '🚀 MAINNET MODE: Conservative monitoring'
        );
        process.on('SIGINT', () => this.stop());
    }

    // === UTILITIES ===
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    createPositionData(position) {
        const positionAmt = parseFloat(position.positionAmt);
        return {
            symbol: position.symbol,
            side: positionAmt > 0 ? 'LONG' : 'SHORT',
            quantity: Math.abs(positionAmt),
            entryPrice: parseFloat(position.entryPrice),
            timestamp: Date.now(),
            stopLoss: parseFloat(position.stopLoss) || 0,
            takeProfit: 0
        };
    }

    getEnvConfig(testnetValue, mainnetValue) {
        return config.environment === 'testnet' ? testnetValue : mainnetValue;
    }

    // === COOLDOWN MANAGEMENT ===
    setCooldown(symbol, seconds) {
        this.cooldowns.set(symbol, Date.now() + (seconds * 1000));
        this.logger.info(`${symbol} cooldown: ${seconds}s`);
    }

    isInCooldown(symbol) {
        const cooldownEnd = this.cooldowns.get(symbol);
        if (!cooldownEnd || Date.now() >= cooldownEnd) {
            this.cooldowns.delete(symbol);
            return false;
        }
        const remaining = Math.ceil((cooldownEnd - Date.now()) / 1000);
        this.logger.debug(`${symbol} cooldown: ${remaining}s remaining`);
        return true;
    }

    // === INITIALIZATION & CONFIGURATION ===
    async initialize() {
        try {
            config.validate();
            const account = await this.client.getAccountInfo();
            this.logger.info(`Connected - Balance: ${parseFloat(account.availableBalance).toFixed(2)} USDT`);

            await Promise.all(config.trading.symbols.map(symbol => this.configureSymbol(symbol)));
            return true;
        } catch (error) {
            this.logger.error(error.message, 'Initialization failed');
            return false;
        }
    }

    async configureSymbol(symbol) {
        try {
            await this.client.setMarginMode(symbol, config.trading.marginMode || 'ISOLATED');
            await this.client.setLeverage(symbol, config.trading.leverage);
            this.logger.info(`${symbol}: ${config.trading.leverage}x (${config.trading.marginMode})`);
        } catch (error) {
            this.logger.error(error.message, `Failed to configure ${symbol}`);
        }
    }

    // === BOT LIFECYCLE ===
    async start() {
        if (this.isRunning) {
            this.logger.info('Bot already running');
            return;
        }

        if (!await this.initialize()) {
            this.logger.error('Failed to initialize');
            return;
        }

        this.isRunning = true;
        this.logger.info('Starting bot...');

        await this.recoverLiveState();
        this.tradingInterval = setInterval(() => this.tradingCycle(), 10000);
        this.monitorInterval = setInterval(() => this.monitorPositions(), 5000);
    }

    stop() {
        this.isRunning = false;
        clearInterval(this.tradingInterval);
        clearInterval(this.monitorInterval);
        this.logger.info('Bot stopped');
    }

    // === TRADING CYCLE ===
    async tradingCycle() {
        if (!this.isRunning) return;

        try {
            const openPositions = await this.client.getOpenPositions();
            const activeCount = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).length;

            if (activeCount >= config.trading.maxOpenPositions) return;

            // ✅ SAFE PARALLEL PROCESSING
            await Promise.allSettled(
                config.trading.symbols.map(symbol =>
                    this.analyzeSymbol(symbol).catch(error => {
                        this.logger.debug(`Parallel skip ${symbol}: ${error.message}`);
                    })
                )
            );
        } catch (error) {
            this.logger.error(error.message, 'Trading cycle error');
        }
    }

    async analyzeSymbol(symbol) {
        if (this.isInCooldown(symbol) || await this.hasOpenPosition(symbol)) return;

        try {
            const klines = await this.client.getKlines(symbol, config.strategy.timeframe, 300);
            if (!klines.length) return;

            const signal = this.strategy.analyze(klines, symbol);
            if (!signal || typeof signal.signal !== 'string') {
                this.logger.error('Strategy returned invalid signal', signal);
                return;
            }

            this.logger.debug(`${symbol} - ${signal.signal}: ${signal.reason}`);

            if (signal.signal !== 'HOLD') {
                this.logger.trade(`${symbol} Signal: ${signal.signal} - ${signal.reason}`);
                await this.executeTrade(symbol, signal);
            }
        } catch (error) {
            this.logger.error(error.message, `Error analyzing ${symbol}`);
        }
    }

    async hasOpenPosition(symbol) {
        const positions = await this.client.getOpenPositions();
        return positions.some(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
    }

    // === TRADE EXECUTION (COMBINED VALIDATION & EXECUTION) ===
    async executeTrade(symbol, signal) {
        if (this.pendingOperations.has(symbol)) {
            this.logger.debug(`⏳ ${symbol} - Operation in progress`);
            return;
        }

        this.pendingOperations.set(symbol, true);

        try {
            if (this.isInCooldown(symbol)) return;

            const [account, openPositions] = await Promise.all([
                this.client.getAccountInfo(),
                this.client.getOpenPositions()
            ]);

            const activeCount = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).length;
            if (activeCount >= config.trading.maxOpenPositions) {
                this.logger.trade(`Max positions reached, skipping ${symbol}`);
                return;
            }

            const quantity = this.strategy.calculatePositionSize(
                parseFloat(account.availableBalance),
                signal.price,
                symbol
            );

            const symbolInfo = await this.client.getSymbolInfo(symbol);
            const adjustedQty = this.client.adjustQuantityToStepSize(
                quantity,
                parseFloat(symbolInfo.filters.LOT_SIZE.stepSize)
            );

            const notional = adjustedQty * signal.price;
            if (notional < parseFloat(symbolInfo.filters.MIN_NOTIONAL.notional)) {
                this.logger.debug(`${symbol} notional too low`);
                return;
            }

            await this.executeMarketOrder(symbol, signal, adjustedQty);
        } catch (error) {
            this.logger.error(error.message, `Trade execution error: ${symbol}`);
        } finally {
            this.pendingOperations.delete(symbol);
        }
    }

    async executeMarketOrder(symbol, signal, quantity) {
        this.logger.trade(`${symbol} ${signal.signal}: ${quantity} @ $${signal.price}`);

        const levels = this.strategy.calculateLevels(signal.price, signal.signal, symbol);
        let marketOrder = null;
        let protectionSuccess = false;

        try {
            marketOrder = await this.client.placeMarketOrder(symbol, signal.signal, quantity);
            this.logger.trade(`${symbol} Order: ${marketOrder.orderId}`);

            await this.placeTPSL(symbol, signal.signal, quantity, levels);
            protectionSuccess = true;

            this.positions.set(marketOrder.orderId, {
                symbol,
                side: signal.signal,
                quantity: quantity,
                entryPrice: signal.price,
                timestamp: Date.now(),
                stopLoss: levels.stopLoss,
                takeProfit: levels.takeProfit
            });

            this.logger.position(
                `OPEN - ${symbol} | ${signal.signal} | ${quantity} @ $${signal.price.toFixed(4)} | ` +
                `SL: $${levels.stopLoss.toFixed(4)} | TP: $${levels.takeProfit.toFixed(4)}`
            );

            this.setCooldown(symbol, 10);
        } catch (atomicError) {
            this.logger.error(`🚨 TRADE OPERATION FAILED: ${symbol} - ${atomicError.message}`);

            if (marketOrder && !protectionSuccess) {
                this.logger.error(`🚨 Market order placed but protection failed - emergency closing`);
                await this.emergencyClose(symbol, signal.signal, quantity);
            }

            throw atomicError;
        }
    }

    // === TP/SL MANAGEMENT (SIMPLIFIED) ===
    async placeTPSL(symbol, side, quantity, levels) {
        this.logger.trade(`${symbol} Placing TP/SL: TP=$${levels.takeProfit.toFixed(4)}, SL=$${levels.stopLoss.toFixed(4)}`);

        const result = await this.client.placeTP_SL_BatchOrders(
            symbol, side, quantity, levels.takeProfit, levels.stopLoss
        );

        const [tpOrder, slOrder] = result;
        const tpSuccess = tpOrder?.orderId && !tpOrder.code;
        const slSuccess = slOrder?.orderId && !slOrder.code;

        if (tpSuccess && slSuccess) {
            this.storeTPSLOrders(symbol, tpOrder.orderId, slOrder.orderId);
            const verified = await this.verifyOrdersExist(symbol, tpOrder.orderId, slOrder.orderId);
            if (!verified) {
                this.logger.warn(`⚠️ ${symbol} TP/SL verification issue - monitoring closely`);
            }
        } else {
            this.handlePartialTPSLFailure(symbol, tpOrder, slOrder);
        }
    }

    storeTPSLOrders(symbol, tpOrderId, slOrderId) {
        if (tpOrderId) {
            this.logger.trade(`TP placed: ${tpOrderId}`);
            this.orders.set(`${symbol}_TP`, tpOrderId);
        }
        if (slOrderId) {
            this.logger.trade(`SL placed: ${slOrderId}`);
            this.orders.set(`${symbol}_SL`, slOrderId);
        }
    }

    handlePartialTPSLFailure(symbol, tpOrder, slOrder) {
        this.logger.warn(`⚠️ ${symbol} Batch partial failure - monitoring`);
        this.storeTPSLOrders(symbol, tpOrder?.orderId, slOrder?.orderId);

        if (tpOrder?.code) this.logger.error(`TP failed: ${tpOrder.msg || tpOrder.code}`);
        if (slOrder?.code) this.logger.error(`SL failed: ${slOrder.msg || slOrder.code}`);

        if (!tpOrder?.orderId && !slOrder?.orderId) {
            this.logger.error(`🚨 ${symbol} BATCH COMPLETE FAILURE`);
            throw new Error('Batch TP/SL failed');
        }
    }

    async verifyOrdersExist(symbol, tpOrderId, slOrderId) {
        try {
            const delay = this.getEnvConfig(3000, 1500);
            const maxRetries = this.getEnvConfig(3, 2);

            await this.sleep(delay);

            for (let i = 0; i < maxRetries; i++) {
                const openOrders = await this.client.getOpenOrders(symbol);
                const tpExists = openOrders.some(o => o.orderId == tpOrderId);
                const slExists = openOrders.some(o => o.orderId == slOrderId);

                if (tpExists && slExists) {
                    this.logger.debug(`✅ TP/SL Verified: ${symbol}`);
                    return true;
                }

                if (i < maxRetries - 1) await this.sleep(1000);
            }

            this.logger.warn(`⚠️ TP/SL Verification failed: ${symbol}`);
            return false;
        } catch (error) {
            this.logger.error(`Verification error for ${symbol}: ${error.message}`);
            return false;
        }
    }

    // === EMERGENCY OPERATIONS ===
    async emergencyClose(symbol, side, quantity) {
        try {
            this.logger.error(`🚨 EMERGENCY CLOSE: ${symbol}`);
            const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
            const result = await this.client.placeMarketOrder(symbol, closeSide, quantity);
            this.logger.error(`🚨 ${symbol} closed. Order: ${result.orderId}`);
        } catch (error) {
            this.logger.error(`🚨 EMERGENCY CLOSE FAILED: ${symbol} - ${error.message}`);
        }
    }

    async cancelAllOrders(symbol) {
        try {
            const openOrders = await this.client.getOpenOrders(symbol);
            for (const order of openOrders) {
                try {
                    await this.client.cancelOrder(symbol, order.orderId);
                    this.logger.debug(`Canceled ${symbol}: ${order.orderId}`);
                } catch (error) {
                    this.logger.debug(`Cancel failed ${order.orderId}: ${error.message}`);
                }
            }
        } catch (error) {
            this.logger.error(`Cancel all orders failed for ${symbol}: ${error.message}`);
        }
    }

    // === POSITION MONITORING & CLEANUP ===
    async monitorPositions() {
        if (!this.isRunning) return;

        try {
            const openPositions = await this.client.getOpenPositions();
            this.logger.debug(`Monitoring: ${openPositions.length} positions`);

            if (config.environment === 'testnet' || Math.random() < this.safetyConfig.orphanCheckFrequency) {
                await this.cleanupOrphanedOrders();
            }

            await this.processClosedPositions(openPositions);
        } catch (error) {
            this.logger.error(error.message, 'Monitoring error');
        }
    }

    async processClosedPositions(openPositions) {
        const closedPositions = Array.from(this.positions.entries())
            .filter(([_, position]) => {
                if (!position?.symbol) return true;
                return !openPositions.some(p =>
                    p.symbol === position.symbol && Math.abs(parseFloat(p.positionAmt)) > 0
                );
            });

        for (const [positionId, position] of closedPositions) {
            await this.logClosedPosition(position);
            this.orders.delete(`${position.symbol}_TP`);
            this.orders.delete(`${position.symbol}_SL`);
            this.positions.delete(positionId);
            this.setCooldown(position.symbol, 30);
        }
    }

    async logClosedPosition(position) {
        try {
            if (!position?.symbol) {
                this.logger.position(`CLOSED - Invalid position removed`);
                return;
            }

            const currentPrice = await this.client.getPrice(position.symbol);
            const pnl = position.side === 'BUY'
                ? (currentPrice - position.entryPrice) * position.quantity
                : (position.entryPrice - currentPrice) * position.quantity;

            this.logger.position(
                `CLOSED - ${position.symbol} | ${position.side} | ` +
                `${position.quantity} @ $${position.entryPrice.toFixed(4)} | ` +
                `Exit: $${currentPrice.toFixed(4)} | PnL: $${pnl.toFixed(2)}`
            );
        } catch (error) {
            this.logger.position(`CLOSED - ${position.symbol} | ${position.side}`);
        }
    }

    // === ORPHANED ORDERS CLEANUP ===
    async cleanupOrphanedOrders() {
        try {
            const [openPositions, allOpenOrders] = await Promise.all([
                this.client.getOpenPositions(),
                this.client.getOpenOrders()
            ]);

            await this.removeOrphanedOrders(allOpenOrders, openPositions);
            await this.handleUnprotectedPositions(openPositions, allOpenOrders);
        } catch (error) {
            this.logger.error(error.message, 'Cleanup error');
        }
    }

    async removeOrphanedOrders(allOpenOrders, openPositions) {
        const symbolsWithPositions = new Set(
            openPositions
                .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
                .map(p => p.symbol)
        );

        const orphans = allOpenOrders.filter(order =>
            ['TAKE_PROFIT', 'STOP_MARKET'].includes(order.type) &&
            !symbolsWithPositions.has(order.symbol)
        );

        for (const order of orphans) {
            try {
                await this.client.cancelOrder(order.symbol, order.orderId);
                this.orders.delete(`${order.symbol}_TP`);
                this.orders.delete(`${order.symbol}_SL`);
            } catch (error) {
                this.logger.debug(`Cancel failed ${order.orderId}: ${error.message}`);
            }
        }
    }

    async handleUnprotectedPositions(openPositions, allOpenOrders) {
        const unprotected = openPositions.filter(position => {
            const positionAmt = parseFloat(position.positionAmt);
            return Math.abs(positionAmt) > 0 && !allOpenOrders.some(order =>
                order.symbol === position.symbol &&
                ['TAKE_PROFIT', 'STOP_MARKET'].includes(order.type)
            );
        });

        if (unprotected.length === 0) return;

        if (config.environment === 'testnet') {
            this.logger.error(`🧪 Testnet: ${unprotected.length} unprotected positions - repairing`);
            for (const position of unprotected) {
                await this.emergencyRepairPosition(position);
            }
        } else {
            this.logger.error(`🚨 MAINNET: ${unprotected.length} UNPROTECTED POSITIONS!`);
            for (const position of unprotected) {
                const data = this.createPositionData(position);
                this.logger.error(`🚨 UNPROTECTED: ${data.symbol} ${data.side} ${data.quantity} @ $${data.entryPrice}`);
            }
        }
    }

    async emergencyRepairPosition(position) {
        if (config.environment !== 'testnet') return;

        const data = this.createPositionData(position);
        this.logger.error(`🧪 EMERGENCY: ${data.symbol} has NO TP/SL! Repairing...`);

        try {
            const currentPrice = await this.client.getPrice(data.symbol);
            const levels = this.strategy.calculateLevels(currentPrice, data.side, data.symbol);

            await this.placeTPSL(data.symbol, data.side, data.quantity, levels);
            this.logger.error(`✅ EMERGENCY TP/SL placed for ${data.symbol}`);
        } catch (error) {
            this.logger.error(`🧪 REPAIR FAILED for ${data.symbol}: ${error.message}`);
            await this.emergencyClose(data.symbol, data.side, data.quantity);
        }
    }

    // === STATE RECOVERY ===
    async recoverLiveState() {
        try {
            this.logger.info('Recovering live state...');

            const openPositions = await this.client.getOpenPositions();
            const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

            this.logger.info(`Found ${activePositions.length} live positions`);

            for (const position of activePositions) {
                const positionData = this.createPositionData(position);
                this.positions.set(`recovered_${position.symbol}_${Date.now()}`, positionData);
                this.logger.position(`Recovered ${position.symbol}: ${positionData.quantity} (${positionData.side})`);
                this.setCooldown(position.symbol, 30);
            }

            this.logger.info('Recovery completed');
        } catch (error) {
            this.logger.error(error.message, 'Recovery failed');
        }
    }

    // === STATUS & LOGS ===
    async getStatus() {
        try {
            const [account, positions, openOrders] = await Promise.all([
                this.client.getAccountInfo(),
                this.client.getOpenPositions(),
                this.client.getOpenOrders()
            ]);

            return {
                running: this.isRunning,
                environment: config.environment,
                account: {
                    balance: parseFloat(account.availableBalance),
                    totalBalance: parseFloat(account.totalWalletBalance),
                    unrealizedPnl: parseFloat(account.totalUnrealizedProfit)
                },
                positions: positions.length,
                openOrders: openOrders.length
            };
        } catch (error) {
            this.logger.error(error.message, 'Status check error');
            return {
                running: this.isRunning,
                environment: config.environment,
                error: error.message
            };
        }
    }

    getLogs(type = 'errors') {
        return this.logger.readLog(type);
    }

    clearLogs(type = 'errors') {
        this.logger.clearLog(type);
    }
}

export default ScalpingBot; 