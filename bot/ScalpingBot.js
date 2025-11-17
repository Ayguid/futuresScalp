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
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    createPositionData = (position) => ({
        symbol: position.symbol,
        side: parseFloat(position.positionAmt) > 0 ? 'LONG' : 'SHORT',
        quantity: Math.abs(parseFloat(position.positionAmt)),
        entryPrice: parseFloat(position.entryPrice),
        timestamp: Date.now(),
        stopLoss: parseFloat(position.stopLoss) || 0,
        takeProfit: position.takeProfit ? parseFloat(position.takeProfit) : 0
    });
    getEnvConfig = (testnet, mainnet) => config.environment === 'testnet' ? testnet : mainnet;
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

    // === TRADE EXECUTION ===
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
        let marketOrder = null;
        let protectionSuccess = false;

        try {
            marketOrder = await this.client.placeMarketOrder(symbol, signal.signal, quantity);
            const filledOrder = await this.waitForOrderFill(marketOrder.orderId, symbol);
            const actualEntryPrice = parseFloat(filledOrder.avgPrice);
            const actualLevels = this.strategy.calculateLevels(actualEntryPrice, signal.signal, symbol);

            this.logger.trade(`✅ ORDER SUCCESS: ${symbol} ${signal.signal} ${quantity} @ $${actualEntryPrice} - Order ID: ${marketOrder.orderId}`);

            await this.placeTPSL(symbol, signal.signal, quantity, actualLevels);
            protectionSuccess = true;

            this.positions.set(`${symbol}_${marketOrder.orderId}`, {
                symbol,
                side: signal.signal,
                quantity: quantity,
                entryPrice: actualEntryPrice,
                timestamp: Date.now(),
                stopLoss: actualLevels.stopLoss,
                takeProfit: actualLevels.takeProfit,
                marketOrderId: marketOrder.orderId
            });

            const indicatorLog = signal.indicators ?
                ` | INDICATORS: ${JSON.stringify(signal.indicators)}` : '';

            this.logger.position(
                `OPEN - ${symbol} | ${signal.signal} | ${quantity} @ $${actualEntryPrice.toFixed(4)} | ` +
                `SL: $${actualLevels.stopLoss.toFixed(4)} | TP: $${actualLevels.takeProfit.toFixed(4)}${indicatorLog}`
            );

            this.setCooldown(symbol, config.trading.cooldowns.afterOpen);
        } catch (atomicError) {
            this.logger.error(`❌ ORDER FAILED: ${symbol} ${signal.signal} ${quantity} - ${atomicError.message}`);

            if (marketOrder && !protectionSuccess) {
                this.logger.error(`🚨 Market order placed but protection failed - emergency closing`);
                await this.emergencyClose(symbol);
            }

            throw atomicError;
        }
    }

    async waitForOrderFill(orderId, symbol, timeout = 10000) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const order = await this.client.getOrder(symbol, orderId);

                if (order.status === 'FILLED') {
                    this.logger.debug(`✅ Order ${orderId} filled at avg price: ${order.avgPrice}`);
                    return order;
                }

                if (order.status === 'CANCELED' || order.status === 'EXPIRED' || order.status === 'REJECTED') {
                    throw new Error(`Order ${orderId} was ${order.status.toLowerCase()}`);
                }

                this.logger.debug(`⏳ Order ${orderId} status: ${order.status}, executedQty: ${order.executedQty}`);
                await this.sleep(500);

            } catch (error) {
                this.logger.error(`Error checking order ${orderId}: ${error.message}`);
                throw error;
            }
        }

        try {
            const finalOrder = await this.client.getOrder(symbol, orderId);
            throw new Error(`Order ${orderId} not filled within ${timeout}ms. Final status: ${finalOrder.status}, executedQty: ${finalOrder.executedQty}`);
        } catch (finalError) {
            throw new Error(`Order ${orderId} not filled within ${timeout}ms and could not check final status: ${finalError.message}`);
        }
    }
    // === TP/SL MANAGEMENT ===
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

    // === EMERGENCY OPERATIONS ===
    async emergencyClose(symbol) {
        try {
            this.logger.error(`🚨 EMERGENCY CLOSE: ${symbol}`);

            const positions = await this.client.getOpenPositions();
            const currentPosition = positions.find(p => p.symbol === symbol);

            if (!currentPosition) {
                this.logger.error(`🚨 No current position found for ${symbol}`);
                this.cleanupPositionTracking(symbol);
                return;
            }

            const positionAmt = parseFloat(currentPosition.positionAmt);
            const currentSize = Math.abs(positionAmt);

            if (currentSize === 0) {
                this.logger.error(`🚨 Position size is 0 for ${symbol}`);
                this.cleanupPositionTracking(symbol);
                return;
            }

            const closeSide = positionAmt > 0 ? 'SELL' : 'BUY';
            const positionSide = positionAmt > 0 ? 'LONG' : 'SHORT';

            this.logger.error(`🚨 Closing ${positionSide} position: ${currentSize} ${symbol}`);
            const result = await this.client.placeMarketOrder(symbol, closeSide, currentSize);
            this.logger.error(`🚨 ${symbol} closed. ${positionSide}->${closeSide} Size: ${currentSize} Order: ${result.orderId}`);

            this.cleanupPositionTracking(symbol);
        } catch (error) {
            this.logger.error(`🚨 EMERGENCY CLOSE FAILED: ${symbol} - ${error.message}`);
            this.cleanupPositionTracking(symbol);
        }
    }

    cleanupPositionTracking(symbol) {
        for (const [key, position] of this.positions.entries()) {
            if (position.symbol === symbol) {
                this.positions.delete(key);
                break;
            }
        }
        this.cleanupPositionOrders(symbol);
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
    // === SIMPLIFIED POSITION MONITORING ===
    async monitorPositions() {
        if (!this.isRunning) return;

        try {
            const openPositions = await this.client.getOpenPositions();
            this.logger.debug(`Monitoring: ${openPositions.length} positions`);

            // ✅ SIMPLE CLEANUP - ONCE PER CYCLE
            await this.cleanupOrphanedOrders(openPositions);

            await this.processClosedPositions(openPositions);
        } catch (error) {
            this.logger.error(error.message, 'Monitoring error');
        }
    }

    // ✅ SIMPLIFIED CLEANUP
    async cleanupOrphanedOrders(openPositions) {
        try {
            const allOpenOrders = await this.client.getOpenOrders();

            const activeSymbols = new Set(
                openPositions
                    .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
                    .map(p => p.symbol)
            );

            for (const order of allOpenOrders) {
                if (!activeSymbols.has(order.symbol) &&
                    ['TAKE_PROFIT', 'STOP_MARKET'].includes(order.type)) {

                    await this.client.cancelOrder(order.symbol, order.orderId);
                    this.logger.debug(`🧹 Canceled orphan: ${order.symbol} ${order.orderId}`);
                }
            }
        } catch (error) {
            this.logger.debug(`Cleanup error: ${error.message}`);
        }
    }

    async processClosedPositions(openPositions) {
        const positionsToClose = [];

        for (const [positionId, position] of this.positions.entries()) {
            if (!position?.symbol || position.closing) continue;

            const stillOpen = openPositions.some(p =>
                p.symbol === position.symbol &&
                Math.abs(parseFloat(p.positionAmt)) > 0
            );

            if (!stillOpen) {
                positionsToClose.push([positionId, { ...position, closing: true }]);
            }
        }

        for (const [positionId, position] of positionsToClose) {
            await this.logClosedPosition(position);
            this.cleanupPositionOrders(position.symbol);
            this.positions.delete(positionId);
            this.setCooldown(position.symbol, config.trading.cooldowns.afterClose);
        }
    }

    cleanupPositionOrders(symbol) {
        this.orders.delete(`${symbol}_TP`);
        this.orders.delete(`${symbol}_SL`);
        this.logger.debug(`🧹 Cleaned tracking for ${symbol}`);
    }

    async logClosedPosition(position) {
        try {
            if (!position?.symbol) {
                this.logger.position(`CLOSED - Invalid position removed`);
                return;
            }

            // ✅ FIND ACTUAL EXIT PRICE FROM ORDERS
            const exitInfo = await this.findActualExitPrice(position);

            const pnl = position.side === 'BUY'
                ? (exitInfo.exitPrice - position.entryPrice) * position.quantity
                : (position.entryPrice - exitInfo.exitPrice) * position.quantity;

            this.logger.position(
                `CLOSED - ${position.symbol} | ${position.side} | ` +
                `${position.quantity} @ $${position.entryPrice.toFixed(4)} | ` +
                `Exit: $${exitInfo.exitPrice.toFixed(4)} | PnL: $${pnl.toFixed(2)} | Reason: ${exitInfo.exitReason}`
            );
        } catch (error) {
            this.logger.position(`CLOSED - ${position.symbol} | ${position.side} | Error: ${error.message}`);
        }
    }

    // ✅ OPTIMIZED METHOD: Find actual exit price using tracked orders first
    async findActualExitPrice(position) {
        const tpOrderId = this.orders.get(`${position.symbol}_TP`);
        const slOrderId = this.orders.get(`${position.symbol}_SL`);

        try {
            // ✅ FIRST: Check our tracked TP/SL orders (most common case)
            if (tpOrderId) {
                try {
                    const tpOrder = await this.client.getOrder(position.symbol, tpOrderId);
                    if (tpOrder.status === 'FILLED') {
                        return {
                            exitPrice: parseFloat(tpOrder.avgPrice),
                            exitReason: 'TAKE_PROFIT',
                            orderId: tpOrderId
                        };
                    }
                } catch (error) {
                    // Order might not exist (already filled and gone from recent history)
                    this.logger.debug(`TP order ${tpOrderId} not found, may be filled`);
                }
            }

            if (slOrderId) {
                try {
                    const slOrder = await this.client.getOrder(position.symbol, slOrderId);
                    if (slOrder.status === 'FILLED') {
                        return {
                            exitPrice: parseFloat(slOrder.avgPrice),
                            exitReason: 'STOP_LOSS',
                            orderId: slOrderId
                        };
                    }
                } catch (error) {
                    // Order might not exist (already filled and gone from recent history)
                    this.logger.debug(`SL order ${slOrderId} not found, may be filled`);
                }
            }

            // ✅ SECOND: Check if orders are still in open orders (to detect manual cancellation)
            const openOrders = await this.client.getOpenOrders(position.symbol);
            const tpStillOpen = openOrders.some(order => order.orderId === tpOrderId);
            const slStillOpen = openOrders.some(order => order.orderId === slOrderId);

            // If our TP/SL are gone but we couldn't get their status, they were likely filled
            if (tpOrderId && !tpStillOpen) {
                this.logger.debug(`TP order ${tpOrderId} missing from open orders, assuming filled`);
                // Use TP price as best estimate
                return {
                    exitPrice: position.takeProfit,
                    exitReason: 'TAKE_PROFIT',
                    orderId: tpOrderId
                };
            }

            if (slOrderId && !slStillOpen) {
                this.logger.debug(`SL order ${slOrderId} missing from open orders, assuming filled`);
                // Use SL price as best estimate
                return {
                    exitPrice: position.stopLoss,
                    exitReason: 'STOP_LOSS',
                    orderId: slOrderId
                };
            }

            // ✅ THIRD: Fallback to getAllOrders only if we can't determine from our tracked orders
            const allOrders = await this.client.getAllOrders(position.symbol);
            const potentialExitOrders = allOrders.filter(order =>
                order.status === 'FILLED' &&
                (
                    (position.side === 'BUY' && order.side === 'SELL') ||
                    (position.side === 'SELL' && order.side === 'BUY')
                ) &&
                Math.abs(parseFloat(order.executedQty) - position.quantity) < 0.0001 &&
                Date.parse(order.updateTime) > position.timestamp
            );

            if (potentialExitOrders.length > 0) {
                const exitOrder = potentialExitOrders[0];
                const exitPrice = parseFloat(exitOrder.avgPrice || exitOrder.price);

                return {
                    exitPrice,
                    exitReason: this.getExitReasonFromOrder(exitOrder),
                    orderId: exitOrder.orderId
                };
            }

        } catch (error) {
            this.logger.debug(`Error finding exit price for ${position.symbol}: ${error.message}`);
        }

        // ✅ FINAL FALLBACK: Use current price from getPrice() method
        try {
            const currentPrice = await this.client.getPrice(position.symbol);
            return {
                exitPrice: currentPrice,
                exitReason: 'UNKNOWN',
                orderId: null
            };
        } catch (fallbackError) {
            return {
                exitPrice: position.entryPrice,
                exitReason: 'UNKNOWN',
                orderId: null
            };
        }
    }

    // ✅ HELPER: Determine exit reason from order type
    getExitReasonFromOrder(order) {
        if (order.type === 'TAKE_PROFIT' || order.type === 'TAKE_PROFIT_MARKET') return 'TAKE_PROFIT';
        if (order.type === 'STOP_MARKET' || order.type === 'STOP_LOSS') return 'STOP_LOSS';
        if (order.type === 'MARKET') return 'MANUAL_CLOSE';
        if (order.type === 'LIMIT') return 'LIMIT_CLOSE';
        return 'UNKNOWN';
    }

    // === STATE RECOVERY ===
    async recoverLiveState() {
        try {
            this.logger.info('Recovering live state...');

            const [openPositions, openOrders] = await Promise.all([
                this.client.getOpenPositions(),
                this.client.getOpenOrders()
            ]);

            const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
            this.logger.info(`Found ${activePositions.length} live positions and ${openOrders.length} open orders`);

            const existingSymbols = new Set(Array.from(this.positions.values()).map(p => p.symbol));

            // ✅ FIRST: Check for positions that closed while bot was offline
            await this.cleanupClosedPositions(openPositions);

            // ✅ SECOND: Recover currently open positions
            for (const position of activePositions) {
                if (existingSymbols.has(position.symbol)) {
                    this.logger.debug(`🔄 ${position.symbol} already tracked, skipping recovery`);
                    continue;
                }

                const positionData = this.createPositionData(position);
                const recoveryId = `${position.symbol}_recovered`;

                // Restore order tracking
                const symbolOrders = openOrders.filter(order => order.symbol === position.symbol);
                for (const order of symbolOrders) {
                    if (order.type === 'TAKE_PROFIT' || order.type === 'TAKE_PROFIT_MARKET') {
                        this.orders.set(`${position.symbol}_TP`, order.orderId);
                        this.logger.debug(`Recovered TP order: ${order.orderId}`);
                    } else if (order.type === 'STOP_MARKET' || order.type === 'STOP_LOSS') {
                        this.orders.set(`${position.symbol}_SL`, order.orderId);
                        this.logger.debug(`Recovered SL order: ${order.orderId}`);
                    }
                }

                this.positions.set(recoveryId, {
                    ...positionData,
                    recovered: true,
                    marketOrderId: recoveryId
                });

                this.logger.position(`Recovered live position: ${position.symbol}: ${positionData.quantity} (${positionData.side})`);
                this.setCooldown(position.symbol, 30);
            }

            this.logger.info('Recovery completed');
        } catch (error) {
            this.logger.error(error.message, 'Recovery failed');
        }
    }

    // ✅ NEW METHOD: Cleanup positions that closed while bot was offline
    async cleanupClosedPositions(currentOpenPositions) {
        const currentOpenSymbols = new Set(
            currentOpenPositions
                .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
                .map(p => p.symbol)
        );

        const positionsToClose = [];

        for (const [positionId, position] of this.positions.entries()) {
            if (!position?.symbol || position.closing) continue;

            // If position symbol is not in currently open positions, it closed while bot was offline
            if (!currentOpenSymbols.has(position.symbol)) {
                positionsToClose.push([positionId, position]);
            }
        }

        // Log and cleanup all positions that closed while offline
        for (const [positionId, position] of positionsToClose) {
            this.logger.info(`🔄 Position ${position.symbol} closed while bot was offline, logging now...`);
            await this.logClosedPosition(position);
            this.cleanupPositionOrders(position.symbol);
            this.positions.delete(positionId);
        }

        if (positionsToClose.length > 0) {
            this.logger.info(`Cleaned up ${positionsToClose.length} positions that closed while bot was offline`);
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
}

export default ScalpingBot;