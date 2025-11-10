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
        
        this.logger.info(`Bot Started - ${config.environment.toUpperCase()}`);
        this.logger.info(`Strategy: ${this.strategy.name}`);
        this.logger.info(config.environment === 'testnet' 
            ? '🧪 TESTNET MODE: Aggressive monitoring' 
            : '🚀 MAINNET MODE: Conservative monitoring'
        );
        
        process.on('SIGINT', () => this.stop());
    }

    // === HELPERS ===
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    createPositionData(position, orderId = null) {
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

    async hasOpenPosition(symbol) {
        const positions = await this.client.getOpenPositions();
        return positions.some(p => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0);
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

    // === INITIALIZATION ===
    async initialize() {
        try {
            config.validate();
            
            const account = await this.client.getAccountInfo();
            this.logger.info(`Connected - Balance: ${parseFloat(account.availableBalance).toFixed(2)} USDT`);
            
            await Promise.all(
                config.trading.symbols.map(symbol => this.configureSymbol(symbol))
            );
            
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
            this.logger.debug(`Trading Cycle - ${new Date().toLocaleTimeString()}`);

            const openPositions = await this.client.getOpenPositions();
            const activeCount = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).length;

            this.logger.debug(`Positions: ${activeCount}/${config.trading.maxOpenPositions}`);

            if (activeCount >= config.trading.maxOpenPositions) {
                this.logger.debug('Max positions reached');
                return;
            }

            for (const symbol of config.trading.symbols) {
                await this.analyzeSymbol(symbol);
            }
        } catch (error) {
            this.logger.error(error.message, 'Trading cycle error');
        }
    }

    async analyzeSymbol(symbol) {
        try {
            if (this.isInCooldown(symbol) || await this.hasOpenPosition(symbol)) {
                return;
            }

            this.logger.debug(`Analyzing ${symbol}...`);

            const klines = await this.client.getKlines(symbol, config.strategy.timeframe, 300);
            if (!klines.length) {
                this.logger.debug(`No data for ${symbol}`);
                return;
            }

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

    // === TRADE EXECUTION ===
    async executeTrade(symbol, signal) {
        if (this.pendingOperations.has(symbol)) {
            this.logger.debug(`⏳ ${symbol} - Operation in progress`);
            return;
        }

        this.pendingOperations.set(symbol, true);

        try {
            await this.validateAndExecuteTrade(symbol, signal);
        } catch (error) {
            this.logger.error(error.message, `Trade execution error: ${symbol}`);
        } finally {
            this.pendingOperations.delete(symbol);
        }
    }

    async validateAndExecuteTrade(symbol, signal) {
        if (this.isInCooldown(symbol)) return;

        const account = await this.client.getAccountInfo();
        const openPositions = await this.client.getOpenPositions();
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
    }

    async executeMarketOrder(symbol, signal, adjustedQty) {
        this.logger.trade(`${symbol} ${signal.signal}: ${adjustedQty} @ $${signal.price}`);

        const levels = this.strategy.calculateLevels(signal.price, signal.signal, symbol);
        let marketOrder = null;
        let protectionSuccess = false;

        try {
            // Step 1: Open position
            marketOrder = await this.client.placeMarketOrder(symbol, signal.signal, adjustedQty);
            this.logger.trade(`${symbol} Order: ${marketOrder.orderId}`);

            // Step 2: Add protection
            await this.placeTPSL(symbol, signal.signal, adjustedQty, levels);
            protectionSuccess = true;

            // Step 3: Store position
            this.positions.set(marketOrder.orderId, {
                symbol,
                side: signal.signal,
                quantity: adjustedQty,
                entryPrice: signal.price,
                timestamp: Date.now(),
                stopLoss: levels.stopLoss,
                takeProfit: levels.takeProfit
            });

            this.logger.position(
                `OPEN - ${symbol} | ${signal.signal} | ${adjustedQty} @ $${signal.price.toFixed(4)} | ` +
                `SL: $${levels.stopLoss.toFixed(4)} | TP: $${levels.takeProfit.toFixed(4)}`,
                signal
            );

            this.setCooldown(symbol, 10);

        } catch (atomicError) {
            this.logger.error(`🚨 TRADE OPERATION FAILED: ${symbol} - ${atomicError.message}`);
            
            if (marketOrder && !protectionSuccess) {
                this.logger.error(`🚨 Market order placed but protection failed - emergency closing`);
                await this.emergencyClose(symbol, signal.signal, adjustedQty);
            }
            
            throw atomicError;
        }
    }

    // === TP/SL MANAGEMENT ===
    async placeTPSL(symbol, side, quantity, levels) {
        this.logger.trade(`${symbol} Placing TP/SL: TP=$${levels.takeProfit.toFixed(4)}, SL=$${levels.stopLoss.toFixed(4)}`);
        
        const result = await this.client.placeTP_SL_BatchOrders(
            symbol,
            side,
            quantity,
            levels.takeProfit,
            levels.stopLoss
        );
        
        this.logger.debug(`${symbol} Batch Result: ${JSON.stringify(result)}`);
        
        const tpSuccess = result[0]?.orderId && !result[0].code;
        const slSuccess = result[1]?.orderId && !result[1].code;
        
        if (tpSuccess && slSuccess) {
            const verified = await this.verifyOrdersExist(symbol, result[0].orderId, result[1].orderId);
            
            if (verified) {
                this.storeTPSLOrders(symbol, result);
            } else {
                this.logger.warn(`⚠️ ${symbol} TP/SL verification issue - monitoring closely`);
                this.storeTPSLOrders(symbol, result);
            }
        } else {
            this.handlePartialTPSLFailure(symbol, result);
        }
    }

    storeTPSLOrders(symbol, result) {
        if (result[0]?.orderId) {
            this.logger.trade(`TP placed: ${result[0].orderId}`);
            this.orders.set(`${symbol}_TP`, result[0].orderId);
        }
        if (result[1]?.orderId) {
            this.logger.trade(`SL placed: ${result[1].orderId}`);
            this.orders.set(`${symbol}_SL`, result[1].orderId);
        }
    }

    handlePartialTPSLFailure(symbol, result) {
        this.logger.warn(`⚠️ ${symbol} Batch partial failure - monitoring`);
        this.storeTPSLOrders(symbol, result);
        
        if (result[0]?.code) this.logger.error(`TP failed: ${result[0].msg || result[0].code}`);
        if (result[1]?.code) this.logger.error(`SL failed: ${result[1].msg || result[1].code}`);
        
        if (!result[0]?.orderId && !result[1]?.orderId) {
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
                
                if (i < maxRetries - 1) {
                    this.logger.debug(`🔄 Retry ${i + 1}/${maxRetries} for ${symbol}`);
                    await this.sleep(1000);
                }
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

    // === CLEANUP & MONITORING ===
    async cleanupOrphanedOrders() {
        try {
            const [openPositions, allOpenOrders] = await Promise.all([
                this.client.getOpenPositions(),
                this.client.getOpenOrders()
            ]);
            
            const symbolsWithPositions = new Set(
                openPositions
                    .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
                    .map(p => p.symbol)
            );
            
            await this.removeOrphanedOrders(allOpenOrders, symbolsWithPositions);
            await this.handleUnprotectedPositions(openPositions, allOpenOrders);
            
        } catch (error) {
            this.logger.error(error.message, 'Cleanup error');
        }
    }

    async removeOrphanedOrders(allOpenOrders, symbolsWithPositions) {
        const orphans = allOpenOrders.filter(order =>
            ['TAKE_PROFIT', 'STOP_MARKET'].includes(order.type) &&
            !symbolsWithPositions.has(order.symbol)
        );

        if (orphans.length === 0) return;

        this.logger.info(`Found ${orphans.length} orphaned orders`);
        
        for (const order of orphans) {
            try {
                await this.client.cancelOrder(order.symbol, order.orderId);
                this.logger.debug(`Canceled ${order.symbol}: ${order.orderId}`);
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
            if (Math.abs(positionAmt) === 0) return false;
            
            return !allOpenOrders.some(order => 
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
            this.logger.error(`🚨 MANUAL INTERVENTION REQUIRED!`);
            
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
            
            this.logger.error(`🧪 Placing emergency TP/SL for ${data.symbol}`);
            await this.placeTPSL(data.symbol, data.side, data.quantity, levels);
            this.logger.error(`✅ EMERGENCY TP/SL placed for ${data.symbol}`);
            
        } catch (error) {
            this.logger.error(`🧪 REPAIR FAILED for ${data.symbol}: ${error.message}`);
            this.logger.error(`🧪 Closing unprotected position: ${data.symbol}`);
            await this.emergencyClose(data.symbol, data.side, data.quantity);
        }
    }

    // === POSITION MONITORING ===
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
                    p.symbol === position.symbol && 
                    Math.abs(parseFloat(p.positionAmt)) > 0
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
            this.logger.position(
                `CLOSED - ${position.symbol} | ${position.side} | ` +
                `${position.quantity} @ $${position.entryPrice.toFixed(4)}`
            );
        }
    }

    // === STATUS & LOGS ===
    async getStatus() {
        try {
            const account = await this.client.getAccountInfo();
            const positions = await this.client.getOpenPositions();
            const openOrders = await this.client.getOpenOrders();

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