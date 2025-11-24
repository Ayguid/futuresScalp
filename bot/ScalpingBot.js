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

        // Constants for better readability
        this.FLOATING_POINT_TOLERANCE = 0.001;
        this.TRADING_CYCLE_INTERVAL = 10000;
        this.MONITORING_INTERVAL = 3000;
        this.ORDER_FILL_TIMEOUT = 10000;

        // Memory management
        this.lastCleanupTime = Date.now();
        this.CLEANUP_INTERVAL = 30 * 60 * 1000;

        // ✅ ADD POSITION CACHE
        this.positionCache = {
            data: [],
            timestamp: 0,
            symbolSet: new Set(),
            maxAge: 5000 // 5 seconds
        };

        this.initBot();
    }

    // === LOCK MANAGEMENT ===
    getAnalysisLockKey(symbol) {
        return `analysis_${symbol}`;
    }

    getTradeLockKey(symbol) {
        return `trade_${symbol}`;
    }

    // === ID MANAGEMENT ===
    generatePositionId(symbol, orderId) {
        return `${symbol}_${orderId}`;
    }

    // === POSITION MANAGEMENT HELPERS ===
    findTrackedPosition(symbol, quantity, entryPrice) {
        return Array.from(this.positions.values())
            .find(p => p.symbol === symbol &&
                Math.abs(p.quantity - quantity) < this.FLOATING_POINT_TOLERANCE &&
                Math.abs(p.entryPrice - entryPrice) < this.FLOATING_POINT_TOLERANCE);
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
        const minCooldown = 5; // Minimum 5 seconds
        const actualSeconds = Math.max(seconds, minCooldown);

        this.cooldowns.set(symbol, Date.now() + (actualSeconds * 1000));
        this.logger.info(`${symbol} cooldown: ${actualSeconds}s`);
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

    // === POSITION CACHE METHODS ===
    async hasOpenPositionCached(symbol) {
        // Use cache if less than maxAge seconds old
        if (this.positionCache && Date.now() - this.positionCache.timestamp < this.positionCache.maxAge) {
            return this.positionCache.symbolSet.has(symbol);
        }
        return null; // Cache expired, need fresh check
    }

    async hasOpenPosition(symbol) {
        // ✅ TRY CACHE FIRST
        const cachedResult = await this.hasOpenPositionCached(symbol);
        if (cachedResult !== null) {
            return cachedResult;
        }

        // Fallback to API call
        const positions = await this.client.getOpenPositions();
        return positions.some(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
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
        this.tradingInterval = setInterval(() => this.tradingCycle(), this.TRADING_CYCLE_INTERVAL);
        this.monitorInterval = setInterval(() => {
            if (this.positions.size > 0) {
                this.monitorPositions();
            }
        }, this.MONITORING_INTERVAL);
    }

    stop() {
        this.isRunning = false;
        clearInterval(this.tradingInterval);
        clearInterval(this.monitorInterval);
        // Cleanup all maps to prevent memory leaks
        this.positions.clear();
        this.orders.clear();
        this.cooldowns.clear();
        this.pendingOperations.clear();
        this.logger.info('Bot stopped');
    }

    // === TRADING CYCLE ===
    async tradingCycle() {
        if (!this.isRunning) return;

        try {
            const openPositions = await this.client.getOpenPositions();

            // ✅ POPULATE POSITION CACHE
            this.positionCache = {
                data: openPositions,
                timestamp: Date.now(),
                symbolSet: new Set(
                    openPositions
                        .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
                        .map(p => p.symbol)
                ),
                maxAge: 5000
            };

            const activeCount = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).length;

            if (activeCount >= config.trading.maxOpenPositions) return;

            // Track symbols that already have positions to avoid analyzing them
            const symbolsWithPositions = this.positionCache.symbolSet;

            await Promise.allSettled(
                config.trading.symbols.map(symbol => {
                    // Skip symbols that already have open positions
                    if (symbolsWithPositions.has(symbol)) {
                        this.logger.debug(`⏩ Skip ${symbol} - already has position`);
                        return Promise.resolve();
                    }
                    return this.analyzeSymbol(symbol).catch(error => {
                        this.logger.debug(`Parallel skip ${symbol}: ${error.message}`);
                    });
                })
            );
        } catch (error) {
            this.logger.error(error.message, 'Trading cycle error');
        }
    }

    async analyzeSymbol(symbol) {
        // ROBUST LOCK CHECK
        const lockKey = this.getAnalysisLockKey(symbol);
        if (this.pendingOperations.has(lockKey)) {
            this.logger.debug(`⏳ ${symbol} - Analysis already in progress`);
            return;
        }

        // Set lock IMMEDIATELY with unique key
        this.pendingOperations.set(lockKey, true);

        try {
            if (this.isInCooldown(symbol)) return;
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
        } finally {
            // ✅ RELEASE THE LOCK
            this.pendingOperations.delete(lockKey);
        }
    }

    // === TRADE EXECUTION ===
    async executeTrade(symbol, signal) {
        // ✅ Check position using cache FIRST
        const cachedPositionCheck = await this.hasOpenPositionCached(symbol);
        if (cachedPositionCheck === true) {
            this.logger.debug(`⏩ ${symbol} - Position exists (cached), skipping trade`);
            return;
        }

        // If cache expired or uncertain, do API check
        if (await this.hasOpenPosition(symbol)) {
            this.logger.debug(`⏩ ${symbol} - Position exists, skipping trade`);
            return;
        }

        const lockKey = this.getTradeLockKey(symbol);
        if (this.pendingOperations.has(lockKey)) {
            this.logger.debug(`⏳ ${symbol} - Trade operation in progress`);
            return;
        }

        this.pendingOperations.set(lockKey, true);

        try {
            // ✅ Double-check position AFTER acquiring lock (use cache first)
            const cachedDoubleCheck = await this.hasOpenPositionCached(symbol);
            if (cachedDoubleCheck === true) {
                this.logger.debug(`⏩ ${symbol} - Position opened during lock acquisition (cached)`);
                return;
            }

            // Final API check if cache uncertain
            if (await this.hasOpenPosition(symbol)) {
                this.logger.debug(`⏩ ${symbol} - Position opened during lock acquisition`);
                return;
            }

            // ✅ Check cooldown AFTER lock acquired
            if (this.isInCooldown(symbol)) {
                this.logger.debug(`⏩ ${symbol} - In cooldown, skipping trade`);
                return;
            }

            const account = await this.client.getAccountInfo();

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
            this.pendingOperations.delete(lockKey);
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

            this.logger.trade(`✅ ORDER SUCCESS: ${symbol} ${signal.signal} ${quantity} @ $${actualEntryPrice}`);

            // ✅ ADD RETRY LOGIC FOR TP/SL
            let tpSlOrders = await this.placeTPSL(symbol, signal.signal, quantity, actualLevels);

            // Check if orders failed
            const tpSuccess = tpSlOrders.tpOrderId;
            const slSuccess = tpSlOrders.slOrderId;

            // Retry once if partial failure
            if (!tpSuccess || !slSuccess) {
                this.logger.warn(`⚠️ TP/SL partial failure, retrying...`);
                await this.sleep(1000);
                tpSlOrders = await this.placeTPSL(symbol, signal.signal, quantity, actualLevels);

                // Check retry success
                const retryTpSuccess = tpSlOrders.tpOrderId;
                const retrySlSuccess = tpSlOrders.slOrderId;

                if (!retryTpSuccess || !retrySlSuccess) {
                    throw new Error(`TP/SL placement failed after retry. TP: ${retryTpSuccess ? 'OK' : 'FAIL'}, SL: ${retrySlSuccess ? 'OK' : 'FAIL'}`);
                }
            }

            // ✅ VERIFY TP/SL ORDERS EXIST
            const verified = await this.verifyOrdersExist(symbol, tpSlOrders.tpOrderId, tpSlOrders.slOrderId);
            if (!verified) {
                throw new Error('TP/SL orders verification failed - orders may not have been placed correctly');
            }

            protectionSuccess = true;
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

    async waitForOrderFill(orderId, symbol, timeout = this.ORDER_FILL_TIMEOUT) {
        const startTime = Date.now();
        let pollCount = 0;
        let lastError = null;

        while (Date.now() - startTime < timeout) {
            try {
                const order = await this.client.getOrder(symbol, orderId);
                pollCount++;

                if (order.status === 'FILLED') {
                    this.logger.debug(`✅ Order ${orderId} filled after ${pollCount} checks`);
                    return order;
                }

                if (order.status === 'CANCELED' || order.status === 'EXPIRED' || order.status === 'REJECTED') {
                    throw new Error(`Order ${orderId} was ${order.status.toLowerCase()}`);
                }

                // ✅ Adaptive polling with error recovery
                const elapsed = Date.now() - startTime;
                const sleepTime = lastError ? 2000 : (elapsed < 5000 ? 500 : 1000);
                await this.sleep(sleepTime);
                lastError = null;

            } catch (error) {
                lastError = error;
                this.logger.debug(`Retry ${pollCount + 1} for order ${orderId}: ${error.message}`);

                // ✅ Longer wait on API errors
                await this.sleep(2000);
            }
        }

        // ✅ Final verification attempt
        try {
            const finalOrder = await this.client.getOrder(symbol, orderId);
            if (finalOrder.status === 'FILLED') {
                this.logger.debug(`✅ Order ${orderId} filled on final check`);
                return finalOrder;
            }
            throw new Error(`Order ${orderId} not filled within ${timeout}ms. Final status: ${finalOrder.status}`);
        } catch (finalError) {
            throw new Error(`Order ${orderId} verification failed: ${finalError.message}`);
        }
    }

    // === TP/SL MANAGEMENT ===
    async placeTPSL(symbol, side, quantity, levels) {
        this.logger.trade(`${symbol} Placing TP/SL: TP=$${levels.takeProfit.toFixed(4)}, SL=$${levels.stopLoss.toFixed(4)}`);

        const result = await this.client.placeTP_SL_BatchOrders(
            symbol, side, quantity, levels.takeProfit, levels.stopLoss
        );

        const [tpOrder, slOrder] = result;

        // Check for partial failures
        const tpSuccess = tpOrder?.orderId && !tpOrder.code;
        const slSuccess = slOrder?.orderId && !slOrder.code;

        if (!tpSuccess || !slSuccess) {
            this.handlePartialTPSLFailure(symbol, tpOrder, slOrder);
        }

        return {
            tpOrderId: tpOrder?.orderId,
            slOrderId: slOrder?.orderId
        };
    }

    // Handle partial TP/SL failures
    handlePartialTPSLFailure(symbol, tpOrder, slOrder) {
        this.logger.debug(`⚠️ ${symbol} Batch partial failure - monitoring closely`);
        this.storeTPSLOrders(symbol, tpOrder?.orderId, slOrder?.orderId);

        if (tpOrder?.code) this.logger.error(`TP failed: ${tpOrder.msg || tpOrder.code}`);
        if (slOrder?.code) this.logger.error(`SL failed: ${slOrder.msg || slOrder.code}`);

        if (!tpOrder?.orderId && !slOrder?.orderId) {
            this.logger.error(`🚨 ${symbol} BATCH COMPLETE FAILURE`);
            throw new Error('Batch TP/SL completely failed');
        }
    }

    // Verify TP/SL orders exist
    async verifyOrdersExist(symbol, tpOrderId, slOrderId) {
        try {
            // USE SAFETY CONFIG DELAY
            await this.sleep(this.safetyConfig.verificationDelay);

            const openOrders = await this.client.getOpenOrders(symbol);
            const tpExists = openOrders.some(o => o.orderId == tpOrderId);
            const slExists = openOrders.some(o => o.orderId == slOrderId);

            if (tpExists && slExists) {
                this.logger.debug(`✅ TP/SL Verified: ${symbol}`);
                return true;
            }

            this.logger.debug(`⚠️ TP/SL Verification failed: ${symbol} - TP: ${tpExists}, SL: ${slExists}`);
            return false;
        } catch (error) {
            this.logger.error(`Verification error for ${symbol}: ${error.message}`);
            return false;
        }
    }

    storeTPSLOrders(symbol, tpOrderId, slOrderId) {
        if (tpOrderId) {
            this.logger.trade(`TP placed: ${tpOrderId}`);
            this.orders.set(`${symbol}_TP`, tpOrderId);
            this.orders.set(`order_${tpOrderId}`, { type: 'TP', symbol });
        }
        if (slOrderId) {
            this.logger.trade(`SL placed: ${slOrderId}`);
            this.orders.set(`${symbol}_SL`, slOrderId);
            this.orders.set(`order_${slOrderId}`, { type: 'SL', symbol });
        }
    }

    // === EMERGENCY OPERATIONS ===
    async emergencyClose(symbol) {
        try {
            this.logger.error(`🚨 EMERGENCY CLOSE: ${symbol}`);

            // ✅ Use cache first for faster response
            let currentPosition = null;
            const cachedPositions = this.positionCache.data.filter(p =>
                p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0
            );

            if (cachedPositions.length > 0 && Date.now() - this.positionCache.timestamp < 10000) {
                currentPosition = cachedPositions[0];
                this.logger.debug(`🚨 Using cached position data for emergency close`);
            } else {
                // Fallback to API call
                const positions = await this.client.getOpenPositions();
                currentPosition = positions.find(p => p.symbol === symbol);
            }

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

            const trackedPosition = this.findTrackedPosition(
                symbol,
                currentSize,
                parseFloat(currentPosition.entryPrice)
            );

            this.logger.error(`🚨 Closing position: ${currentSize} ${symbol}`);
            const result = await this.client.placeMarketOrder(symbol, closeSide, currentSize);

            if (trackedPosition) {
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
        for (const [positionId, position] of this.positions.entries()) {
            if (position.symbol === symbol) {
                this.positions.delete(positionId);
            }
        }
        this.cleanupPositionOrders(symbol);
    }

    // === MEMORY MANAGEMENT ===
    async cleanupStaleTracking() {
        const STALE_THRESHOLD = 2 * 60 * 60 * 1000; // 2 hours
        const now = Date.now();
        const stalePositions = [];

        // ✅ STEP 1: Identify stale positions
        for (const [positionId, position] of this.positions.entries()) {
            if (now - position.timestamp > STALE_THRESHOLD) {
                stalePositions.push({ positionId, position });
            }
        }

        // Early exit if nothing is stale
        if (stalePositions.length === 0) {
            return;
        }

        this.logger.debug(`🔍 Checking ${stalePositions.length} stale positions`);

        try {
            // ✅ STEP 2: ONE API call to get all open positions
            const openPositions = await this.client.getOpenPositions();

            // ✅ STEP 3: Build a NESTED MAP for O(1) lookups
            // Structure: Map<symbol, Map<quantity, Map<entryPrice, position>>>
            const activePositionsMap = new Map();

            for (const p of openPositions) {
                const positionAmt = Math.abs(parseFloat(p.positionAmt));
                if (positionAmt === 0) continue;

                const symbol = p.symbol;
                const entryPrice = parseFloat(p.entryPrice);

                if (!activePositionsMap.has(symbol)) {
                    activePositionsMap.set(symbol, new Map());
                }
                const quantityMap = activePositionsMap.get(symbol);

                if (!quantityMap.has(positionAmt)) {
                    quantityMap.set(positionAmt, new Map());
                }
                const priceMap = quantityMap.get(positionAmt);

                priceMap.set(entryPrice, p);
            }

            // ✅ STEP 4: Ultra-fast lookup with tolerance checks
            let cleanedCount = 0;
            for (const { positionId, position } of stalePositions) {
                let stillActive = false;

                // ✅ FIRST: Check exact symbol (O(1))
                if (activePositionsMap.has(position.symbol)) {
                    const quantityMap = activePositionsMap.get(position.symbol);

                    // ✅ SECOND: Check quantities with tolerance
                    for (const [activeQty, priceMap] of quantityMap.entries()) {
                        if (Math.abs(activeQty - position.quantity) < this.FLOATING_POINT_TOLERANCE) {

                            // ✅ THIRD: Check prices with tolerance  
                            for (const [activePrice] of priceMap.entries()) {
                                if (Math.abs(activePrice - position.entryPrice) < this.FLOATING_POINT_TOLERANCE) {
                                    stillActive = true;
                                    break;
                                }
                            }
                            if (stillActive) break;
                        }
                    }
                }

                if (!stillActive) {
                    this.logger.debug(`🧹 Removing stale position tracking: ${positionId}`);
                    this.positions.delete(positionId);
                    this.cleanupPositionOrders(position.symbol);
                    cleanedCount++;
                }
            }

            if (cleanedCount > 0) {
                this.logger.info(`🧹 Cleaned ${cleanedCount} stale position entries`);
            }
        } catch (error) {
            this.logger.debug(`Cleanup check failed: ${error.message}`);
        }
    }

    // === MONITORING METHODS ===
    async monitorPositions() {
        if (!this.isRunning) return;

        try {
            // ✅ Periodic cleanup of stale tracking
            if (Date.now() - this.lastCleanupTime > this.CLEANUP_INTERVAL) {
                await this.cleanupStaleTracking();
                this.lastCleanupTime = Date.now();
            }

            this.logger.debug(`📊 Monitoring ${this.positions.size} tracked positions`);

            // USE SAFETY CONFIG FOR CLEANUP AND PROTECTION CHECKS
            if (this.safetyConfig.continuousMonitoring) {
                this.logger.debug('🔧 Running safety checks...');
                await this.cleanupOrphanedOrders();
                await this.checkUnprotectedPositions();
            }

            await this.monitorPositionClosures();
        } catch (error) {
            this.logger.error(error.message, 'Monitoring error');
        }
    }

    async monitorPositionClosures() {
        const positionsSnapshot = Array.from(this.positions.entries());
        if (positionsSnapshot.length === 0) return;

        for (const [positionId, position] of positionsSnapshot) {
            if (this.isInCooldown(position.symbol)) continue;
            if (!this.positions.has(positionId)) continue;

            try {
                // ✅ STEP 1: Check if position actually exists
                const positionExists = await this.hasOpenPosition(position.symbol);

                if (!positionExists) {
                    // ✅ STEP 2: Position closed - find REAL reason
                    await this.findRealClosureReason(positionId, position);
                }
            } catch (error) {
                this.logger.debug(`Monitor error for ${position.symbol}: ${error.message}`);
            }
        }
    }

    async findRealClosureReason(positionId, position) {
        let reason = 'MANUAL_CLOSE';
        let exitPrice = position.entryPrice;

        // ✅ CHECK SL ORDER FIRST - MOST IMPORTANT FIX!
        if (position.slOrderId) {
            try {
                const slOrder = await this.client.getOrder(position.symbol, position.slOrderId);
                if (slOrder.status === 'FILLED') {
                    reason = 'STOP_LOSS';
                    exitPrice = parseFloat(slOrder.avgPrice) || position.stopLoss;
                }
            } catch (error) {
                // SL order not found
            }
        }

        // ✅ ONLY CHECK TP IF SL WASN'T FILLED
        if (reason === 'MANUAL_CLOSE' && position.tpOrderId) {
            try {
                const tpOrder = await this.client.getOrder(position.symbol, position.tpOrderId);
                if (tpOrder.status === 'FILLED') {
                    reason = 'TAKE_PROFIT';
                    exitPrice = parseFloat(tpOrder.avgPrice) || position.takeProfit;
                }
            } catch (error) {
                // TP order not found
            }
        }

        // ✅ CLOSE THE POSITION WITH CORRECT REASON
        await this.closePositionByOrder(positionId, position, reason, {
            avgPrice: exitPrice
        });
    }

    async determineClosureReason(symbol, symbolPositions) {
        // ✅ POSITION IS CLOSED - Find out why
        for (const { positionId, position } of symbolPositions) {
            if (!this.positions.has(positionId)) continue;

            let closureReason = 'UNKNOWN';
            let exitPrice = position.entryPrice; // Default to avoid errors

            try {
                // ✅ CHECK SL ORDER FIRST (most common closure)
                if (position.slOrderId) {
                    try {
                        const slOrder = await this.client.getOrder(symbol, position.slOrderId);
                        if (slOrder.status === 'FILLED') {
                            closureReason = 'STOP_LOSS';
                            exitPrice = parseFloat(slOrder.avgPrice) || position.stopLoss;
                        }
                    } catch (error) {
                        // Order not found - might be filled
                        this.logger.debug(`SL order ${position.slOrderId} not found for ${symbol}`);
                    }
                }

                // ✅ CHECK TP ORDER ONLY IF SL WASN'T FILLED
                if (closureReason === 'UNKNOWN' && position.tpOrderId) {
                    try {
                        const tpOrder = await this.client.getOrder(symbol, position.tpOrderId);
                        if (tpOrder.status === 'FILLED') {
                            closureReason = 'TAKE_PROFIT';
                            exitPrice = parseFloat(tpOrder.avgPrice) || position.takeProfit;
                        } else if (tpOrder.status === 'CANCELED') {
                            closureReason = 'MANUAL_CLOSE'; // TP canceled but position closed
                        }
                    } catch (error) {
                        this.logger.debug(`TP order ${position.tpOrderId} not found for ${symbol}`);
                    }
                }

                // ✅ IF STILL UNKNOWN, USE AVERAGE OF SL/TP AS BEST GUESS
                if (closureReason === 'UNKNOWN') {
                    closureReason = 'AUTO_CLOSE';
                    exitPrice = (position.stopLoss + position.takeProfit) / 2;
                    this.logger.debug(`Using estimated exit price for ${symbol}: $${exitPrice.toFixed(4)}`);
                }

                // ✅ LOG THE CLOSURE
                await this.closePositionByOrder(positionId, position, closureReason, {
                    avgPrice: exitPrice
                });

            } catch (error) {
                this.logger.error(`Failed to determine closure for ${symbol}: ${error.message}`);
                // Emergency close with unknown reason
                await this.closePositionByOrder(positionId, position, 'UNKNOWN', {
                    avgPrice: position.entryPrice
                });
            }
        }
    }

    async monitorOpenPositionOrders(symbol, symbolPositions) {
        // ✅ POSITION STILL OPEN - Just check if TP/SL orders exist
        const openOrders = await this.client.getOpenOrders(symbol);
        const openOrderIds = new Set(openOrders.map(o => o.orderId.toString()));

        for (const { positionId, position } of symbolPositions) {
            if (!this.positions.has(positionId)) continue;

            // Check if TP/SL orders are missing (might need repair)
            const tpMissing = position.tpOrderId && !openOrderIds.has(position.tpOrderId.toString());
            const slMissing = position.slOrderId && !openOrderIds.has(position.slOrderId.toString());

            if (tpMissing || slMissing) {
                this.logger.warn(`⚠️ Missing TP/SL orders for ${symbol}, may need repair`);
                // Could trigger emergency repair here
            }
        }
    }

    // Check for unprotected positions
    async checkUnprotectedPositions() {
        try {
            const [openPositions, allOpenOrders] = await Promise.all([
                this.client.getOpenPositions(),
                this.client.getOpenOrders()
            ]);

            const unprotected = [];
            const canceledTP_SL = [];

            for (const position of openPositions) {
                const positionAmt = parseFloat(position.positionAmt);
                if (Math.abs(positionAmt) === 0) continue;

                const symbolOrders = allOpenOrders.filter(o => o.symbol === position.symbol);
                const hasTP_SL = symbolOrders.some(order =>
                    ['TAKE_PROFIT', 'STOP_MARKET'].includes(order.type)
                );

                if (!hasTP_SL) {
                    unprotected.push(position);
                } else {
                    // ✅ CHECK FOR CANCELED ORDERS USING EXISTING DATA
                    const trackedPosition = this.findTrackedPosition(
                        position.symbol,
                        Math.abs(positionAmt),
                        parseFloat(position.entryPrice)
                    );

                    if (trackedPosition?.tpOrderId || trackedPosition?.slOrderId) {
                        const tpOrder = symbolOrders.find(o => o.orderId == trackedPosition.tpOrderId);
                        const slOrder = symbolOrders.find(o => o.orderId == trackedPosition.slOrderId);

                        if (!tpOrder || !slOrder) {
                            canceledTP_SL.push(position);
                        }
                    }
                }
            }

            // Handle unprotected positions
            if (unprotected.length > 0) {
                this.logger.debug(`Found ${unprotected.length} unprotected positions`);
                if (this.safetyConfig.emergencyRepair) {
                    for (const position of unprotected) {
                        await this.emergencyRepairPosition(position);
                    }
                }
            }

            // ✅ NEW: Handle canceled TP/SL orders
            if (canceledTP_SL.length > 0) {
                this.logger.debug(`Found ${canceledTP_SL.length} positions with canceled TP/SL`);
                if (this.safetyConfig.emergencyRepair) {
                    for (const position of canceledTP_SL) {
                        await this.emergencyRepairPosition(position);
                    }
                }
            }

        } catch (error) {
            this.logger.error(`Unprotected check error: ${error.message}`);
        }
    }

    // Emergency repair for unprotected positions
    async emergencyRepairPosition(position) {
        try {
            const symbol = position.symbol;
            const positionAmt = parseFloat(position.positionAmt);
            const quantity = Math.abs(positionAmt);
            const entryPrice = parseFloat(position.entryPrice);
            const side = positionAmt > 0 ? 'BUY' : 'SELL';

            this.logger.debug(`🛠️ EMERGENCY REPAIR: ${symbol} ${side} ${quantity} @ $${entryPrice}`);

            // USE THE ORIGINAL ENTRY PRICE, not current price!
            const repairedLevels = this.strategy.calculateLevels(entryPrice, side, symbol);

            this.logger.debug(`🛠️ Repair levels - TP: $${repairedLevels.takeProfit}, SL: $${repairedLevels.stopLoss}`);

            // Place new TP/SL orders
            const newTpSlOrders = await this.placeTPSL(symbol, side, quantity, repairedLevels);

            // Store the new order IDs
            this.storeTPSLOrders(symbol, newTpSlOrders.tpOrderId, newTpSlOrders.slOrderId);

            // Use helper method for position finding
            this.logger.debug(`🔍 Looking for position: ${symbol} ${side} ${quantity} @ $${entryPrice}`);
            const trackedPosition = this.findTrackedPosition(symbol, quantity, entryPrice);

            if (trackedPosition) {
                this.logger.debug(`✅ Found tracked position: ${trackedPosition.positionId}`);
                trackedPosition.tpOrderId = newTpSlOrders.tpOrderId;
                trackedPosition.slOrderId = newTpSlOrders.slOrderId;
                trackedPosition.stopLoss = repairedLevels.stopLoss;
                trackedPosition.takeProfit = repairedLevels.takeProfit;
                this.logger.debug(`✅ Position tracking updated: ${symbol}`);
            } else {
                // Create new tracking if not found
                this.logger.debug(`🆕 Creating new position tracking for ${symbol}`);
                const positionId = this.generatePositionId(symbol, `repaired_${Date.now()}`);
                this.positions.set(positionId, {
                    positionId,
                    symbol,
                    side,
                    quantity,
                    entryPrice,
                    timestamp: Date.now(),
                    stopLoss: repairedLevels.stopLoss,
                    takeProfit: repairedLevels.takeProfit,
                    marketOrderId: `repaired_${Date.now()}`,
                    tpOrderId: newTpSlOrders.tpOrderId,
                    slOrderId: newTpSlOrders.slOrderId,
                    repaired: true
                });
            }

            this.logger.debug(`✅ Position repaired: ${symbol}`);

        } catch (repairError) {
            this.logger.error(`❌ EMERGENCY REPAIR FAILED for ${position.symbol}: ${repairError.message}`);
            this.logger.error(`🚨 Repair failed - emergency closing ${position.symbol}`);
            await this.emergencyClose(position.symbol);
        }
    }

    // Cleanup orphaned orders
    async cleanupOrphanedOrders() {
        try {
            const [allOpenOrders, openPositions] = await Promise.all([
                this.client.getOpenOrders(),
                this.client.getOpenPositions()
            ]);

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
                    this.logger.debug(`🧹 Cleaned orphan order: ${order.symbol} ${order.orderId}`);
                } catch (error) {
                    this.logger.debug(`Orphan cancel failed ${order.orderId}: ${error.message}`);
                }
            }
        } catch (error) {
            this.logger.error(`Orphan cleanup error: ${error.message}`);
        }
    }

    async closePositionByOrder(positionId, position, reason, order) {
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

        this.positions.delete(positionId);
        this.cleanupPositionOrders(position.symbol);
        this.setCooldown(position.symbol, config.trading.cooldowns.afterClose);
    }

    cleanupPositionOrders(symbol) {
        const tpOrderId = this.orders.get(`${symbol}_TP`);
        const slOrderId = this.orders.get(`${symbol}_SL`);

        this.orders.delete(`${symbol}_TP`);
        this.orders.delete(`${symbol}_SL`);
        if (tpOrderId) this.orders.delete(`order_${tpOrderId}`);
        if (slOrderId) this.orders.delete(`order_${slOrderId}`);
    }

    // === STATE RECOVERY METHODS ===
    async recoverLiveState() {
        try {
            this.logger.info('🔄 Starting state recovery...');

            const [openPositions, allOpenOrders] = await Promise.all([
                this.client.getOpenPositions(),
                this.client.getOpenOrders()
            ]);

            const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
            this.logger.info(`Found ${activePositions.length} live positions and ${allOpenOrders.length} open orders`);

            await this.removeStalePositions(activePositions);
            await this.recoverActivePositions(activePositions, allOpenOrders);
            await this.cleanupPhantomPositions(activePositions);
            for (const [positionId, position] of this.positions.entries()) {
                const stillExists = await this.hasOpenPosition(position.symbol);
                if (!stillExists) {
                    this.logger.error(`🚨 Removing phantom position: ${positionId}`);
                    this.positions.delete(positionId);
                    this.cleanupPositionOrders(position.symbol);
                }
            }
            this.logger.info(`✅ Recovery completed: ${this.positions.size} positions tracked`);
        } catch (error) {
            this.logger.error(error.message, 'Recovery failed');
        }
    }

    async removeStalePositions(activePositions) {
        let removedCount = 0;
        for (const [positionId, trackedPosition] of this.positions.entries()) {
            const stillExists = activePositions.some(binancePos =>
                binancePos.symbol === trackedPosition.symbol &&
                Math.abs(parseFloat(binancePos.positionAmt) - trackedPosition.quantity) < this.FLOATING_POINT_TOLERANCE
            );

            if (!stillExists) {
                this.logger.debug(`🔄 Removing tracked position that no longer exists: ${trackedPosition.symbol}`);
                this.positions.delete(positionId);
                this.cleanupPositionOrders(trackedPosition.symbol);
                removedCount++;
            }
        }
        if (removedCount > 0) {
            this.logger.debug(`🧹 Removed ${removedCount} stale positions`);
        }
    }

    async recoverActivePositions(activePositions, allOpenOrders) {
        let recoveredCount = 0;

        for (const binancePosition of activePositions) {
            const symbol = binancePosition.symbol;
            const positionAmt = parseFloat(binancePosition.positionAmt);
            const quantity = Math.abs(positionAmt);
            const entryPrice = parseFloat(binancePosition.entryPrice);

            const alreadyTracked = this.findTrackedPosition(symbol, quantity, entryPrice);

            if (!alreadyTracked) {
                await this.recoverSinglePosition(binancePosition, allOpenOrders, recoveredCount);
                recoveredCount++;
            }
        }

        if (recoveredCount > 0) {
            this.logger.info(`🔄 Recovered ${recoveredCount} new positions`);
        }
    }

    async recoverSinglePosition(binancePosition, allOpenOrders, index) {
        const symbol = binancePosition.symbol;
        const positionAmt = parseFloat(binancePosition.positionAmt);
        const quantity = Math.abs(positionAmt);
        const entryPrice = parseFloat(binancePosition.entryPrice);
        const side = positionAmt > 0 ? 'BUY' : 'SELL';

        const symbolOrders = allOpenOrders.filter(o => o.symbol === symbol);
        const tpOrder = symbolOrders.find(o => o.type.includes('TAKE_PROFIT'));
        const slOrder = symbolOrders.find(o => o.type.includes('STOP'));

        const positionId = `recovered_${symbol}_${Date.now()}_${index}`;

        this.positions.set(positionId, {
            positionId,
            symbol,
            side: side,
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
    }

    async cleanupPhantomPositions(activePositions) {
        let phantomCount = 0;
        for (const [positionId, position] of this.positions.entries()) {
            if (position.recovered) {
                const stillExists = activePositions.some(bp =>
                    bp.symbol === position.symbol &&
                    Math.abs(parseFloat(bp.positionAmt) - position.quantity) < this.FLOATING_POINT_TOLERANCE
                );
                if (!stillExists) {
                    this.logger.debug(`🔄 Removing phantom recovered position: ${position.symbol}`);
                    this.positions.delete(positionId);
                    this.cleanupPositionOrders(position.symbol);
                    phantomCount++;
                }
            }
        }
        if (phantomCount > 0) {
            this.logger.debug(`🧹 Removed ${phantomCount} phantom positions`);
        }
    }
}

export default ScalpingBot;