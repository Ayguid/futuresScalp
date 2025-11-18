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
        this.positions = new Map(); // 🎯 ID -> Position (single source of truth)
        this.orders = new Map();
        this.cooldowns = new Map();
        this.pendingOperations = new Map();
        this.initBot();
    }

    // === ID MANAGEMENT ===
    generatePositionId(symbol, orderId) {
        return `${symbol}_${orderId}`; // 🎯 Deterministic ID generation
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
        //this.monitorInterval = setInterval(() => this.monitorPositions(), 5000);
        // Monitor frequently (3s) only when positions exist
        this.monitorInterval = setInterval(() => {
            if (this.positions.size > 0) {
                this.monitorPositions();
            }
        }, 3000);
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

            // 🎯 FIX: Capture the returned TP/SL orders
            const tpSlOrders = await this.placeTPSL(symbol, signal.signal, quantity, actualLevels);
            protectionSuccess = true;
            // 🎯 FIX: Store the orders in the orders Map
            this.storeTPSLOrders(symbol, tpSlOrders.tpOrderId, tpSlOrders.slOrderId);
            const positionId = this.generatePositionId(symbol, marketOrder.orderId);
            this.positions.set(positionId, {
                positionId,
                symbol,
                side: signal.signal,
                quantity: quantity,
                entryPrice: actualEntryPrice,
                timestamp: Date.now(),
                stopLoss: actualLevels.stopLoss,
                takeProfit: actualLevels.takeProfit,
                marketOrderId: marketOrder.orderId,
                // 🎯 FIX: Now tpSlOrders is defined
                tpOrderId: tpSlOrders.tpOrderId,
                slOrderId: tpSlOrders.slOrderId
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

        // 🎯 RETURN the order IDs so we can store them with the position
        return {
            tpOrderId: tpOrder?.orderId,
            slOrderId: slOrder?.orderId
        };
    }

    storeTPSLOrders(symbol, tpOrderId, slOrderId) {
        if (tpOrderId) {
            this.logger.trade(`TP placed: ${tpOrderId}`);
            this.orders.set(`${symbol}_TP`, tpOrderId);
            // 🎯 FIX: Store reverse mapping for order lookup
            this.orders.set(`order_${tpOrderId}`, { type: 'TP', symbol });
        }
        if (slOrderId) {
            this.logger.trade(`SL placed: ${slOrderId}`);
            this.orders.set(`${symbol}_SL`, slOrderId);
            // 🎯 FIX: Store reverse mapping for order lookup
            this.orders.set(`order_${slOrderId}`, { type: 'SL', symbol });
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

            // 🎯 FIND TRACKED POSITION FOR LOGGING
            const trackedPosition = Array.from(this.positions.values())
                .find(p => p.symbol === symbol);

            this.logger.error(`🚨 Closing position: ${currentSize} ${symbol}`);
            const result = await this.client.placeMarketOrder(symbol, closeSide, currentSize);

            // 🎯 LOG IN STANDARD FORMAT
            if (trackedPosition) {
                // 🎯 USE ACTUAL EXECUTION PRICE FOR ACCURATE P&L
                const exitPrice = parseFloat(result.avgPrice) || await this.client.getPrice(symbol);
                const pnl = trackedPosition.side === 'BUY'
                    ? (exitPrice - trackedPosition.entryPrice) * trackedPosition.quantity
                    : (trackedPosition.entryPrice - exitPrice) * trackedPosition.quantity;

                this.logger.position(
                    `CLOSED - ${symbol} | ${trackedPosition.side} | ` +
                    `${trackedPosition.quantity} @ $${trackedPosition.entryPrice.toFixed(4)} | ` +
                    `Exit: $${exitPrice.toFixed(4)} | PnL: $${pnl.toFixed(2)} | ` +
                    `Reason: EMERGENCY | TradeID: ${trackedPosition.positionId}`
                );
            }

            this.cleanupPositionTracking(symbol);
        } catch (error) {
            this.logger.error(`🚨 EMERGENCY CLOSE FAILED: ${symbol} - ${error.message}`);
            this.cleanupPositionTracking(symbol);
        }
    }

    cleanupPositionTracking(symbol) {
        // 🎯 Clean up by symbol using ID pattern matching
        for (const [positionId, position] of this.positions.entries()) {
            if (position.symbol === symbol) {
                this.positions.delete(positionId);
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

    async monitorPositions() {
        if (!this.isRunning) return;

        try {
            // 🎯 CREATE SNAPSHOT to avoid modification during iteration
            const positionsSnapshot = Array.from(this.positions.entries());
            for (const [positionId, position] of positionsSnapshot) {
                // Skip if position was already closed in this iteration
                if (!this.positions.has(positionId)) continue;
                
                // Check TP order directly
                if (position.tpOrderId) {
                    try {
                        const tpOrder = await this.client.getOrder(position.symbol, position.tpOrderId);
                        if (tpOrder.status === 'FILLED') {
                            await this.closePositionByOrder(positionId, position, 'TAKE_PROFIT', tpOrder);
                            continue;
                        }
                    } catch (error) {
                        this.logger.debug(`TP order ${position.tpOrderId} not found, may be filled: ${error.message}`);
                        // If order not found, check if position still exists on Binance
                        const openPositions = await this.client.getOpenPositions();
                        const stillExists = openPositions.some(p =>
                            p.symbol === position.symbol &&
                            Math.abs(parseFloat(p.positionAmt)) > 0
                        );
                        if (!stillExists) {
                            await this.closePositionByOrder(positionId, position, 'TAKE_PROFIT', {
                                avgPrice: position.takeProfit
                            });
                            continue; // 🎯 ADD THIS CONTINUE!
                        }
                    }
                }

                // Check SL order directly  
                if (position.slOrderId) {
                    try {
                        const slOrder = await this.client.getOrder(position.symbol, position.slOrderId);
                        if (slOrder.status === 'FILLED') {
                            await this.closePositionByOrder(positionId, position, 'STOP_LOSS', slOrder);
                            continue;
                        }
                    } catch (error) {
                        this.logger.debug(`SL order ${position.slOrderId} not found, may be filled: ${error.message}`);
                        // If order not found, check if position still exists on Binance
                        const openPositions = await this.client.getOpenPositions();
                        const stillExists = openPositions.some(p =>
                            p.symbol === position.symbol &&
                            Math.abs(parseFloat(p.positionAmt)) > 0
                        );
                        if (!stillExists) {
                            await this.closePositionByOrder(positionId, position, 'STOP_LOSS', {
                                avgPrice: position.stopLoss
                            });
                            continue; // 🎯 ADD THIS CONTINUE!
                        }
                    }
                }
            }
        } catch (error) {
            this.logger.error(error.message, 'Monitoring error');
        }
    }

    async closePositionByOrder(positionId, position, reason, order) {
        // 🎯 LOG FIRST before any cleanup
        const exitPrice = parseFloat(order.avgPrice);
        const pnl = position.side === 'BUY'
            ? (exitPrice - position.entryPrice) * position.quantity
            : (position.entryPrice - exitPrice) * position.quantity;

        this.logger.position(
            `CLOSED - ${position.symbol} | ${position.side} | ` +
            `${position.quantity} @ $${position.entryPrice.toFixed(4)} | ` +
            `Exit: $${exitPrice.toFixed(4)} | PnL: $${pnl.toFixed(2)} | Reason: ${reason} | ` +
            `TradeID: ${position.positionId}`
        );

        // 🎯 CLEANUP AFTER LOGGING
        this.positions.delete(positionId);
        this.cleanupPositionOrders(position.symbol);
        this.setCooldown(position.symbol, config.trading.cooldowns.afterClose);
    }

    cleanupPositionOrders(symbol) {
        this.orders.delete(`${symbol}_TP`);
        this.orders.delete(`${symbol}_SL`);
        this.logger.debug(`🧹 Cleaned orders for ${symbol}`);
    }

// === STATE RECOVERY ===
async recoverLiveState() {
    try {
        this.logger.info('Recovering live state...');

        const [openPositions, allOpenOrders] = await Promise.all([
            this.client.getOpenPositions(),
            this.client.getOpenOrders()
        ]);

        const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
        this.logger.info(`Found ${activePositions.length} live positions and ${allOpenOrders.length} open orders`);

        // 🆕 FIX: Clean up positions that no longer exist on Binance
        for (const [positionId, trackedPosition] of this.positions.entries()) {
            const stillExists = activePositions.some(binancePos => 
                binancePos.symbol === trackedPosition.symbol &&
                Math.abs(parseFloat(binancePos.positionAmt) - trackedPosition.quantity) < 0.001
            );
            
            if (!stillExists) {
                this.logger.debug(`🔄 Removing tracked position that no longer exists: ${trackedPosition.symbol}`);
                this.positions.delete(positionId);
                this.cleanupPositionOrders(trackedPosition.symbol);
            }
        }

        // 🆕 FIX: Only recover positions that ACTUALLY EXIST on Binance
        let recoveredCount = 0;
        for (const binancePosition of activePositions) {
            const symbol = binancePosition.symbol;
            const positionAmt = parseFloat(binancePosition.positionAmt);
            const quantity = Math.abs(positionAmt);
            const entryPrice = parseFloat(binancePosition.entryPrice);
            const side = positionAmt > 0 ? 'BUY' : 'SELL';

            // Check if we're already tracking this exact position
            const alreadyTracked = Array.from(this.positions.values()).some(p =>
                p.symbol === symbol &&
                Math.abs(p.quantity - quantity) < 0.001 &&
                Math.abs(p.entryPrice - entryPrice) < 0.001 &&
                p.side === side
            );

            if (!alreadyTracked) {
                // Find TP/SL orders for this symbol
                const symbolOrders = allOpenOrders.filter(o => o.symbol === symbol);
                const tpOrder = symbolOrders.find(o => o.type.includes('TAKE_PROFIT'));
                const slOrder = symbolOrders.find(o => o.type.includes('STOP'));

                const positionId = `recovered_${symbol}_${Date.now()}_${recoveredCount}`;

                this.positions.set(positionId, {
                    positionId,
                    symbol,
                    side: side, // 🎯 Use actual side from Binance position
                    quantity,
                    entryPrice,
                    timestamp: Date.now(),
                    stopLoss: slOrder ? parseFloat(slOrder.stopPrice) : 0,
                    takeProfit: tpOrder ? parseFloat(tpOrder.price) : 0,
                    marketOrderId: positionId,
                    tpOrderId: tpOrder?.orderId,
                    slOrderId: slOrder?.orderId,
                    recovered: true
                });

                // Store order mappings
                if (tpOrder) {
                    this.orders.set(`${symbol}_TP`, tpOrder.orderId);
                    this.orders.set(`order_${tpOrder.orderId}`, { type: 'TP', symbol });
                }
                if (slOrder) {
                    this.orders.set(`${symbol}_SL`, slOrder.orderId);
                    this.orders.set(`order_${slOrder.orderId}`, { type: 'SL', symbol });
                }

                this.logger.position(
                    `OPEN - ${symbol} | ${side} | ${quantity} @ $${entryPrice.toFixed(4)} | ` +
                    `SL: $${(slOrder ? parseFloat(slOrder.stopPrice) : 0).toFixed(4)} | TP: $${(tpOrder ? parseFloat(tpOrder.price) : 0).toFixed(4)} | ` +
                    `Recovered: true | TradeID: ${positionId}`
                );
                recoveredCount++;
            }
        }

        // 🆕 FIX: Clean up any recovered positions that don't actually exist
        for (const [positionId, position] of this.positions.entries()) {
            if (position.recovered) {
                const stillExists = activePositions.some(bp => 
                    bp.symbol === position.symbol &&
                    Math.abs(parseFloat(bp.positionAmt) - position.quantity) < 0.001
                );
                if (!stillExists) {
                    this.logger.warn(`🔄 Removing phantom recovered position: ${position.symbol}`);
                    this.positions.delete(positionId);
                    this.cleanupPositionOrders(position.symbol);
                }
            }
        }

        this.logger.info(`Recovery completed: ${this.positions.size} positions tracked (${recoveredCount} new)`);

    } catch (error) {
        this.logger.error(error.message, 'Recovery failed');
    }
}
}

export default ScalpingBot;