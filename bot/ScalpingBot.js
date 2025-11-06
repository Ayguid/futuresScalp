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
        
        this.safetyConfig = config.getSafetyConfig();
        
        this.logger.info(`Bot Started - ${config.environment.toUpperCase()}`);
        this.logger.info(`Strategy: ${this.strategy.name}`);
        
        process.on('SIGINT', () => this.stop());
    }

    // === COOLDOWN MANAGEMENT ===
    setCooldown(symbol, seconds) {
        this.cooldowns.set(symbol, Date.now() + (seconds * 1000));
        this.logger.info(`${symbol} cooldown: ${seconds}s`);
    }

    isInCooldown(symbol) {
        const cooldownEnd = this.cooldowns.get(symbol);
        if (!cooldownEnd) return false;
        
        if (Date.now() < cooldownEnd) {
            const remaining = Math.ceil((cooldownEnd - Date.now()) / 1000);
            this.logger.debug(`${symbol} cooldown: ${remaining}s remaining`);
            return true;
        }
        
        this.cooldowns.delete(symbol);
        return false;
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
                const positionAmt = parseFloat(position.positionAmt);
                const side = positionAmt > 0 ? 'LONG' : 'SHORT';
                
                this.positions.set(`recovered_${position.symbol}_${Date.now()}`, {
                    symbol: position.symbol,
                    side,
                    quantity: Math.abs(positionAmt),
                    entryPrice: parseFloat(position.entryPrice),
                    timestamp: Date.now(),
                    stopLoss: parseFloat(position.stopLoss) || 0,
                    takeProfit: 0
                });
                
                this.logger.position(`Recovered ${position.symbol}: ${Math.abs(positionAmt)} (${side})`);
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
        
        this.tradingInterval = setInterval(() => this.tradingCycle(), 7000);
        this.monitorInterval = setInterval(() => this.monitorPositions(), 3000);
    }

    stop() {
        this.isRunning = false;
        clearInterval(this.tradingInterval);
        clearInterval(this.monitorInterval);
        this.logger.info('Bot stopped');
    }

    // === STATE RECOVERY ===
    async recoverLiveState() {
        try {
            this.logger.info('Recovering live state...');
            
            const openPositions = await this.client.getOpenPositions();
            const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
            
            this.logger.info(`Found ${activePositions.length} live positions`);
            
            for (const position of activePositions) {
                const positionAmt = parseFloat(position.positionAmt);
                const side = positionAmt > 0 ? 'LONG' : 'SHORT';
                
                this.positions.set(`recovered_${position.symbol}_${Date.now()}`, {
                    symbol: position.symbol,
                    side,
                    quantity: Math.abs(positionAmt),
                    entryPrice: parseFloat(position.entryPrice),
                    timestamp: Date.now(),
                    stopLoss: parseFloat(position.stopLoss) || 0,
                    takeProfit: 0
                });
                
                this.logger.position(`Recovered ${position.symbol}: ${Math.abs(positionAmt)} (${side})`);
                this.setCooldown(position.symbol, 30);
            }
            
            this.logger.info('Recovery completed');
        } catch (error) {
            this.logger.error(error.message, 'Recovery failed');
        }
    }

    // === TRADING CYCLE ===
    async tradingCycle() {
        if (!this.isRunning) return;

        try {
            this.logger.debug(`Trading Cycle - ${new Date().toLocaleTimeString()}`);

            const openPositions = await this.client.getOpenPositions();
            const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

            this.logger.debug(`Positions: ${activePositions.length}/${config.trading.maxOpenPositions}`);

            // Periodic orphan cleanup
            if (Math.random() < this.safetyConfig.orphanCheckFrequency) {
                await this.cleanupOrphanedOrders();
            }

            // Check if we can open new positions
            if (activePositions.length >= config.trading.maxOpenPositions) {
                this.logger.debug('Max positions reached');
                return;
            }

            // Analyze each symbol sequentially to avoid rate limits
            for (const symbol of config.trading.symbols) {
                await this.analyzeSymbol(symbol);
            }
        } catch (error) {
            this.logger.error(error.message, 'Trading cycle error');
        }
    }

    async analyzeSymbol(symbol) {
        try {
            if (this.isInCooldown(symbol)) return;

            // Check for existing position
            const openPositions = await this.client.getOpenPositions();
            const hasPosition = openPositions.some(p =>
                p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0
            );

            if (hasPosition) {
                this.logger.debug(`${symbol} - Position already open`);
                return;
            }

            this.logger.debug(`Analyzing ${symbol}...`);

            const klines = await this.client.getKlines(symbol, config.strategy.timeframe, 300);
            if (!klines.length) {
                this.logger.debug(`No data for ${symbol}`);
                return;
            }

            const signal = this.strategy.analyze(klines, symbol);
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
        try {
            if (this.isInCooldown(symbol)) return;

            const account = await this.client.getAccountInfo();
            const availableBalance = parseFloat(account.availableBalance);
            
            // Check max positions
            const openPositions = await this.client.getOpenPositions();
            const activeCount = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0).length;
            
            if (activeCount >= config.trading.maxOpenPositions) {
                this.logger.trade(`Max positions reached, skipping ${symbol}`);
                return;
            }

            // Calculate position size
            const quantity = this.strategy.calculatePositionSize(
                availableBalance,
                signal.price,
                symbol
            );

            const symbolInfo = await this.client.getSymbolInfo(symbol);
            const adjustedQty = this.client.adjustQuantityToStepSize(
                quantity,
                parseFloat(symbolInfo.filters.LOT_SIZE.stepSize)
            );

            // Validate notional value
            const notional = adjustedQty * signal.price;
            const minNotional = parseFloat(symbolInfo.filters.MIN_NOTIONAL.notional);
            if (notional < minNotional) {
                this.logger.debug(`${symbol} notional too low`);
                return;
            }

            this.logger.trade(`${symbol} ${signal.signal}: ${adjustedQty} @ ${signal.price}`);

            const levels = this.strategy.calculateLevels(signal.price, signal.signal, symbol);

            // Place market order
            const order = await this.client.placeMarketOrder(symbol, signal.signal, adjustedQty);
            this.logger.trade(`${symbol} Order: ${order.orderId}`);

            // Place TP/SL batch orders
            await this.placeTPSL(symbol, signal.signal, adjustedQty, levels);

            // Store position
            this.positions.set(order.orderId, {
                symbol,
                side: signal.signal,
                quantity: adjustedQty,
                entryPrice: signal.price,
                timestamp: Date.now(),
                stopLoss: levels.stopLoss,
                takeProfit: levels.takeProfit
            });

            this.logger.position(
                `OPEN - ${symbol} | ${signal.signal} | ${adjustedQty} @ $${signal.price} | ` +
                `SL: $${levels.stopLoss.toFixed(2)} | TP: $${levels.takeProfit.toFixed(2)}`
            );

            this.setCooldown(symbol, 5);
        } catch (error) {
            this.logger.error(error, `Trade execution error: ${symbol}`);
        }
    }

    async placeTPSL(symbol, side, quantity, levels) {
        try {
            this.logger.trade(`${symbol} Placing TP/SL batch...`);
            
            const result = await this.client.placeTP_SL_BatchOrders(
                symbol,
                side,
                quantity,
                levels.takeProfit,
                levels.stopLoss
            );
            
            const tpSuccess = result[0]?.orderId && !result[0].code;
            const slSuccess = result[1]?.orderId && !result[1].code;
            
            if (tpSuccess && slSuccess) {
                this.logger.trade(`${symbol} TP/SL placed: TP=${result[0].orderId}, SL=${result[1].orderId}`);
                this.orders.set(`${symbol}_TP`, result[0].orderId);
                this.orders.set(`${symbol}_SL`, result[1].orderId);
            } else {
                this.logger.error(`🚨 ${symbol} BATCH FAILED - EMERGENCY CLOSE`);
                if (result[0]?.code) this.logger.error(`TP failed: ${result[0].msg}`);
                if (result[1]?.code) this.logger.error(`SL failed: ${result[1].msg}`);
                
                await this.emergencyClose(symbol, side, quantity);
                throw new Error('Batch TP/SL failed - position closed');
            }
        } catch (error) {
            this.logger.error(`🚨 Batch TP/SL error: ${error.message}`);
            await this.emergencyClose(symbol, side, quantity);
            throw error;
        }
    }

    async emergencyClose(symbol, side, quantity) {
        try {
            this.logger.error(`🚨 EMERGENCY CLOSE: ${symbol}`);
            const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
            await this.client.placeMarketOrder(symbol, closeSide, quantity);
            this.logger.error(`🚨 ${symbol} position closed - TP/SL failed`);
        } catch (error) {
            this.logger.error(`🚨 EMERGENCY CLOSE FAILED: ${symbol} - ${error.message}`);
        }
    }

    // === CLEANUP ===
    async cleanupOrphanedOrders() {
        try {
            const openPositions = await this.client.getOpenPositions();
            const allOpenOrders = await this.client.getOpenOrders();
            
            this.logger.debug(`Checking: ${openPositions.length} positions, ${allOpenOrders.length} orders`);
            
            const symbolsWithPositions = new Set(
                openPositions
                    .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
                    .map(p => p.symbol)
            );
            
            const orphanedOrders = allOpenOrders.filter(order =>
                ['TAKE_PROFIT', 'STOP_MARKET', 'STOP'].includes(order.type) &&
                !symbolsWithPositions.has(order.symbol)
            );
            
            if (orphanedOrders.length > 0) {
                this.logger.error(`Found ${orphanedOrders.length} orphaned orders`);
                
                for (const order of orphanedOrders) {
                    try {
                        await this.client.cancelOrder(order.symbol, order.orderId);
                        this.logger.debug(`Canceled ${order.symbol}: ${order.orderId}`);
                        
                        if (order.type === 'TAKE_PROFIT') {
                            this.orders.delete(`${order.symbol}_TP`);
                        } else if (['STOP_MARKET', 'STOP'].includes(order.type)) {
                            this.orders.delete(`${order.symbol}_SL`);
                        }
                    } catch (error) {
                        this.logger.debug(`Cancel failed ${order.orderId}: ${error.message}`);
                    }
                }
            }
        } catch (error) {
            this.logger.error(error.message, 'Cleanup error');
        }
    }

    // === MONITORING ===
    async monitorPositions() {
        if (!this.isRunning) return;

        try {
            const openPositions = await this.client.getOpenPositions();
            this.logger.debug(`Monitoring: ${openPositions.length} positions`);
            
            await this.cleanupOrphanedOrders();
            
            // Clean up closed positions
            for (const [positionId, position] of this.positions) {
                const stillOpen = openPositions.some(p =>
                    p.symbol === position.symbol &&
                    Math.abs(parseFloat(p.positionAmt)) > 0
                );

                if (!stillOpen) {
                    this.logger.position(
                        `CLOSED - ${position.symbol} | ${position.side} | ` +
                        `${position.quantity} @ $${position.entryPrice}`
                    );
                    
                    this.orders.delete(`${position.symbol}_TP`);
                    this.orders.delete(`${position.symbol}_SL`);
                    this.positions.delete(positionId);
                    this.setCooldown(position.symbol, 30);
                }
            }
        } catch (error) {
            this.logger.error(error.message, 'Monitoring error');
        }
    }

    // === STATUS & LOGS ===
    async getStatus() {
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
    }

    getLogs(type = 'errors') {
        return this.logger.readLog(type);
    }

    clearLogs(type = 'errors') {
        this.logger.clearLog(type);
    }
}

export default ScalpingBot;

/*
//Version 9 - WITH BATCH ORDERS + SAFETY CONFIG + EMERGENCY FAILSAFE + ORPHANED ORDER CLEANUP + LOGGING
import BinanceClient from './binanceClient.js';
import StrategyFactory from './strategies/strategyFactory.js';
import config from './config.js';
import Logger from './logger.js';

class ScalpingBot {
    constructor() {
        this.client = new BinanceClient();
        this.strategy = StrategyFactory.createStrategy(config.strategy.name, config);
        this.isRunning = false;
        this.positions = new Map();
        this.orders = new Map(); // For state recovery only
        this.cooldowns = new Map();
        this.logger = new Logger();

        // 🛡️ CHANGE 1: Get safety config
        this.safetyConfig = config.getSafetyConfig();

        this.logger.info(`Scalping Bot Started - Environment: ${config.environment.toUpperCase()}`);
        this.logger.info(`Strategy: ${this.strategy.name}`);
        
        process.on('SIGINT', () => {
            this.logger.info('Manual shutdown detected...');
            process.exit(0);
        });
    }

    setCooldown(symbol, seconds) {
        this.cooldowns.set(symbol, Date.now() + (seconds * 1000));
        this.logger.info(`${symbol} cooldown set: ${seconds} seconds`);
    }

    isInCooldown(symbol) {
        const cooldownEnd = this.cooldowns.get(symbol);
        if (cooldownEnd && Date.now() < cooldownEnd) {
            const remaining = Math.ceil((cooldownEnd - Date.now()) / 1000);
            this.logger.debug(`${symbol} in cooldown: ${remaining}s remaining`);
            return true;
        }
        if (cooldownEnd && Date.now() >= cooldownEnd) {
            this.cooldowns.delete(symbol);
        }
        return false;
    }

    async initialize() {
        try {
            config.validate();

            const account = await this.client.getAccountInfo();
            this.logger.info(`Connected to Binance ${config.environment}`);
            this.logger.info(`Account Balance: ${parseFloat(account.availableBalance).toFixed(2)} USDT`);
            this.logger.info(`Using ${this.strategy.name} strategy`);

            for (const symbol of config.trading.symbols) {
                try {
                    await this.client.setMarginMode(symbol, config.trading.marginMode || 'ISOLATED');
                    await this.client.setLeverage(symbol, config.trading.leverage);
                    this.logger.info(`${symbol}: ${config.trading.leverage}x leverage (${config.trading.marginMode} mode)`);
                } catch (error) {
                    this.logger.error(error.message, `Failed to configure ${symbol}`);
                }
            }

            return true;
        } catch (error) {
            this.logger.error(error.message, 'Initialization failed');
            return false;
        }
    }

    async start() {
        if (this.isRunning) {
            this.logger.info('Bot is already running');
            return;
        }

        const initialized = await this.initialize();
        if (!initialized) {
            this.logger.error('Failed to initialize bot');
            return;
        }

        this.isRunning = true;
        this.logger.info('Starting scalping bot...');

        // Recover live state
        await this.recoverLiveState();

        // Main trading loop
        this.tradingInterval = setInterval(() => {
            this.tradingCycle();
        }, 7000);

        // Monitor positions
        this.monitorInterval = setInterval(() => {
            this.monitorPositions();
        }, 3000);
    }

    stop() {
        this.isRunning = false;
        if (this.tradingInterval) clearInterval(this.tradingInterval);
        if (this.monitorInterval) clearInterval(this.monitorInterval);
        this.logger.info('Scalping Bot Stopped');
    }

    async recoverLiveState() {
        try {
            this.logger.info('Recovering live state from Binance...');
            
            const openPositions = await this.client.getOpenPositions();
            const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
            
            this.logger.info(`Found ${activePositions.length} live positions on Binance`);
            
            for (const position of activePositions) {
                const positionAmt = parseFloat(position.positionAmt);
                const side = positionAmt > 0 ? 'LONG' : 'SHORT';
                
                const positionId = `recovered_${position.symbol}_${Date.now()}`;
                
                this.positions.set(positionId, {
                    symbol: position.symbol,
                    side: side,
                    quantity: Math.abs(positionAmt),
                    entryPrice: parseFloat(position.entryPrice),
                    timestamp: Date.now(),
                    stopLoss: parseFloat(position.stopLoss) || 0,
                    takeProfit: 0
                });
                
                this.logger.position(`Recovered ${position.symbol}: ${Math.abs(positionAmt)} (${side})`);
                this.setCooldown(position.symbol, 30);
            }
            
            this.logger.info('Live state recovery completed');
            
        } catch (error) {
            this.logger.error(error.message, 'State recovery failed');
        }
    }

    async tradingCycle() {
        if (!this.isRunning) return;

        try {
            this.logger.debug(`Trading Cycle - ${new Date().toLocaleTimeString()}`);

            const openPositions = await this.client.getOpenPositions();
            const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

            this.logger.debug(`Open Positions: ${activePositions.length}/${config.trading.maxOpenPositions}`);

            activePositions.forEach(p => {
                this.logger.debug(`${p.symbol}: ${parseFloat(p.positionAmt)} (PnL: ${parseFloat(p.unRealizedProfit).toFixed(2)} USDT)`);
            });

            // 🛡️ CHANGE 2: Use safety config for orphan check frequency
            if (Math.random() < this.safetyConfig.orphanCheckFrequency) {
                await this.checkAndCleanupClosedPositions();
            }

            if (activePositions.length >= config.trading.maxOpenPositions) {
                this.logger.debug(`Max positions (${config.trading.maxOpenPositions}) reached, skipping new trades`);
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
            // CHECK COOLDOWN FIRST
            if (this.isInCooldown(symbol)) {
                return;
            }

            // Skip if symbol already has open position
            const openPositions = await this.client.getOpenPositions();
            const existingPosition = openPositions.find(p =>
                p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0
            );

            if (existingPosition) {
                const positionSide = parseFloat(existingPosition.positionAmt) > 0 ? 'LONG' : 'SHORT';
                const pnl = parseFloat(existingPosition.unRealizedProfit).toFixed(2);
                this.logger.debug(`${symbol} - Skipping analysis (${positionSide} position active, PnL: ${pnl} USDT)`);
                return;
            }

            this.logger.debug(`Analyzing ${symbol}...`);

            // Get recent market data
            const klines = await this.client.getKlines(symbol, config.strategy.timeframe, 300);
            this.logger.debug(`Got ${klines.length} klines`);

            if (klines.length === 0) {
                this.logger.debug(`No klines data for ${symbol}`);
                return;
            }

            const currentPrice = klines[klines.length - 1].close;
            this.logger.debug(`Current Price: $${currentPrice}`);

            // Analyze with strategy
            const signal = this.strategy.analyze(klines, symbol);
            this.logger.debug(`Signal: ${signal.signal} - ${signal.reason}`);

            if (signal.signal !== 'HOLD') {
                this.logger.trade(`${symbol} Signal: ${signal.signal} - ${signal.reason}`);
                await this.executeTrade(symbol, signal);
            }
        } catch (error) {
            this.logger.error(error.message, `Error analyzing ${symbol}`);
        }
    }

    async executeTrade(symbol, signal) {
        try {
            // CHECK COOLDOWN
            if (this.isInCooldown(symbol)) {
                this.logger.debug(`${symbol} - In cooldown, skipping trade`);
                return;
            }

            const account = await this.client.getAccountInfo();
            const availableBalance = parseFloat(account.availableBalance);
            const currentPrice = signal.price;

            const openPositions = await this.client.getOpenPositions();
            const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

            if (activePositions.length >= config.trading.maxOpenPositions) {
                this.logger.trade(`SAFETY: Max positions reached, cancelling ${symbol} trade`);
                return;
            }

            const quantity = this.strategy.calculatePositionSize(
                availableBalance,
                currentPrice,
                symbol
            );

            const symbolInfo = await this.client.getSymbolInfo(symbol);
            const adjustedQuantity = this.client.adjustQuantityToStepSize(
                quantity,
                parseFloat(symbolInfo.filters.LOT_SIZE.stepSize)
            );

            const notional = adjustedQuantity * currentPrice;
            const minNotional = parseFloat(symbolInfo.filters.MIN_NOTIONAL.notional);
            if (notional < minNotional) {
                this.logger.debug(`${symbol}: Notional ${notional.toFixed(2)} below minimum ${minNotional}, skipping`);
                return;
            }

            this.logger.trade(`${symbol} Executing ${signal.signal}: ${adjustedQuantity} at ${currentPrice}`);

            const levels = this.strategy.calculateLevels(
                currentPrice,
                signal.signal,
                symbol
            );

            this.logger.trade(`${symbol} Risk Levels - Stop Loss: ${levels.stopLoss.toFixed(2)}, Take Profit: ${levels.takeProfit.toFixed(2)}`);

            // 1. Place market order (opens position)
            const order = await this.client.placeMarketOrder(symbol, signal.signal, adjustedQuantity);
            this.logger.trade(`${symbol} Order placed: ${order.orderId}`);

            // 2. Place TP/SL orders using BATCH ORDER (atomic operation)
            await this.placeStopLossAndTakeProfit(symbol, signal.signal, adjustedQuantity, levels);

            // Store position information
            this.positions.set(order.orderId, {
                symbol: symbol,
                side: signal.signal,
                quantity: adjustedQuantity,
                entryPrice: currentPrice,
                timestamp: Date.now(),
                stopLoss: levels.stopLoss,
                takeProfit: levels.takeProfit
            });

            // Log the complete position to file
            this.logger.position(`OPEN - ${symbol} | ${signal.signal} | Qty: ${adjustedQuantity} | Entry: $${currentPrice} | SL: $${levels.stopLoss.toFixed(2)} | TP: $${levels.takeProfit.toFixed(2)}`);

            this.setCooldown(symbol, 5);

        } catch (error) {
            this.logger.error(error, `Trade execution error for ${symbol}`);
        }
    }

async placeStopLossAndTakeProfit(symbol, side, quantity, levels) {
    try {
        // 🚀 USE CLIENT'S BATCH METHOD - ALL PARAM HANDLING DONE THERE
        this.logger.trade(`${symbol} Placing TP/SL batch orders...`);
        const result = await this.client.placeTP_SL_BatchOrders(
            symbol, 
            side, 
            quantity, 
            levels.takeProfit, 
            levels.stopLoss
        );
        
        // Check if both orders succeeded
        const tpSuccess = result[0] && result[0].orderId && !result[0].code;
        const slSuccess = result[1] && result[1].orderId && !result[1].code;
        
        if (tpSuccess && slSuccess) {
            this.logger.trade(`${symbol} TP/SL batch orders placed successfully`);
            this.logger.trade(`${symbol} Take Profit: ${result[0].orderId} at ${levels.takeProfit}`);
            this.logger.trade(`${symbol} Stop Loss: ${result[1].orderId} at ${levels.stopLoss}`);
            
            this.orders.set(`${symbol}_TP`, result[0].orderId);
            this.orders.set(`${symbol}_SL`, result[1].orderId);
        } else {
            // ❌ BATCH FAILED - EMERGENCY CLOSE
            this.logger.error(`🚨 ${symbol} BATCH ORDER FAILED - EMERGENCY CLOSE`);
            if (result[0] && result[0].code) {
                this.logger.error(`TP Order failed: ${result[0].msg}`);
            }
            if (result[1] && result[1].code) {
                this.logger.error(`SL Order failed: ${result[1].msg}`);
            }
            
            await this.emergencyClosePosition(symbol, side, quantity);
            throw new Error('Batch TP/SL failed - position closed for safety');
        }

    } catch (error) {
        this.logger.error(`🚨 Batch TP/SL error: ${error.message}`);
        await this.emergencyClosePosition(symbol, side, quantity);
        throw error;
    }
}

    // 🛡️ EMERGENCY POSITION CLOSE
    async emergencyClosePosition(symbol, side, quantity) {
        try {
            this.logger.error(`🚨 EMERGENCY: Closing unprotected position for ${symbol}`);
            const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
            await this.client.placeMarketOrder(symbol, closeSide, quantity);
            this.logger.error(`🚨 EMERGENCY: ${symbol} position closed - TP/SL protection failed`);
        } catch (error) {
            this.logger.error(`🚨 EMERGENCY CLOSE FAILED for ${symbol}: ${error.message}`);
        }
    }

    // ADD ORPHANED ORDER CLEANUP METHOD
    async checkAndCleanupClosedPositions() {
        try {
            const openPositions = await this.client.getOpenPositions();
            const allOpenOrders = await this.client.getOpenOrders();
            
            this.logger.debug(`CHECKING FOR CLOSED POSITIONS:`);
            this.logger.debug(`Open Positions: ${openPositions.length}`);
            this.logger.debug(`Open Orders: ${allOpenOrders.length}`);
            
            // Get all symbols that currently have open positions
            const symbolsWithOpenPositions = new Set(
                openPositions
                    .filter(p => Math.abs(parseFloat(p.positionAmt)) > 0)
                    .map(p => p.symbol)
            );
            
            // Find TP/SL orders for symbols that DON'T have open positions
            const orphanedOrders = allOpenOrders.filter(order => 
                (order.type === 'TAKE_PROFIT' || order.type === 'STOP_MARKET' || order.type === 'STOP') &&
                !symbolsWithOpenPositions.has(order.symbol)
            );
            
            if (orphanedOrders.length > 0) {
                this.logger.error(`FOUND ${orphanedOrders.length} ORPHANED ORDERS (no position but orders exist):`);
                
                for (const order of orphanedOrders) {
                    try {
                        this.logger.debug(`${order.symbol}: Canceling ${order.type} order ${order.orderId}`);
                        await this.client.cancelOrder(order.symbol, order.orderId);
                        this.logger.debug(`Canceled: ${order.orderId}`);
                        
                        // Also clean up local tracking
                        if (order.type === 'TAKE_PROFIT') {
                            this.orders.delete(`${order.symbol}_TP`);
                        } else if (order.type === 'STOP_MARKET' || order.type === 'STOP') {
                            this.orders.delete(`${order.symbol}_SL`);
                        }
                        
                    } catch (error) {
                        this.logger.debug(`${order.orderId}: ${error.message}`);
                    }
                }
            } else {
                this.logger.debug(`No orphaned orders found`);
            }
            
        } catch (error) {
            this.logger.error(error.message, 'Closed position check error');
        }
    }

    async monitorPositions() {
        if (!this.isRunning) return;

        try {
            const openPositions = await this.client.getOpenPositions();
            
            this.logger.debug(`POSITION STATUS: ${openPositions.length} open`);
            
            // CHECK FOR CLOSED POSITIONS WITH ORPHANED ORDERS
            await this.checkAndCleanupClosedPositions();
            
            // Clean up our tracked positions that closed
            for (const [positionId, position] of this.positions) {
                const stillOpen = openPositions.find(p =>
                    p.symbol === position.symbol &&
                    Math.abs(parseFloat(p.positionAmt)) > 0
                );

                if (!stillOpen) {
                    this.logger.position(`CLOSED - ${position.symbol} | ${position.side} | Qty: ${position.quantity} | Entry: $${position.entryPrice}`);
                    
                    // Clean up local tracking
                    this.orders.delete(`${position.symbol}_TP`);
                    this.orders.delete(`${position.symbol}_SL`);
                    this.positions.delete(positionId);
                    this.setCooldown(position.symbol, 30);
                    
                    this.logger.debug(`Cleaned up local tracking for ${position.symbol}`);
                }
            }

        } catch (error) {
            this.logger.error(error.message, 'Position monitoring error');
        }
    }

    async getStatus() {
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
    }

    // ADD LOG MANAGEMENT METHODS
    getLogs(type = 'errors') {
        return this.logger.readLog(type);
    }

    clearLogs(type = 'errors') {
        this.logger.clearLog(type);
    }
}

export default ScalpingBot;
*/