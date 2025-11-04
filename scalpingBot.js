const BinanceClient = require('./binanceClient');
const StrategyFactory = require('./strategies/strategyFactory');
const PerformanceTracker = require('./utils/performanceTracker');

const config = require('./config');

class ScalpingBot {
    constructor() {
        this.client = new BinanceClient();
        this.strategy = StrategyFactory.createStrategy(config.strategy.name, config);
        this.isRunning = false;
        this.positions = new Map();
        this.orders = new Map();

        console.log(`🤖 Scalping Bot Started - Environment: ${config.environment.toUpperCase()}`);
        console.log(`🎯 Strategy: ${this.strategy.name}`); // ✅ Now shows strategy name
    }

    async initialize() {
        try {
            // Validate configuration
            config.validate();

            // Test connection
            const account = await this.client.getAccountInfo();
            console.log(`✅ Connected to Binance ${config.environment}`);
            console.log(`💰 Account Balance: ${parseFloat(account.availableBalance).toFixed(2)} USDT`);
            console.log(`⚡ Using ${this.strategy.name} strategy`);

            // 🆕 SET MARGIN MODE AND LEVERAGE FOR EACH SYMBOL
            for (const symbol of config.trading.symbols) {
                try {
                    // 1. Set margin mode first
                    await this.client.setMarginMode(symbol, config.trading.marginMode || 'ISOLATED');

                    // 2. Then set leverage
                    await this.client.setLeverage(symbol, config.trading.leverage);
                    console.log(`⚡ ${symbol}: ${config.trading.leverage}x leverage (${config.trading.marginMode} mode)`);

                } catch (error) {
                    console.error(`❌ Failed to configure ${symbol}:`, error.message);
                    // Continue with other symbols even if one fails
                }
            }

            return true;
        } catch (error) {
            console.error('❌ Initialization failed:', error.message);
            return false;
        }
    }


    async start() {
        if (this.isRunning) {
            console.log('⚠️ Bot is already running');
            return;
        }

        const initialized = await this.initialize();
        if (!initialized) {
            console.error('❌ Failed to initialize bot');
            return;
        }

        this.isRunning = true;
        console.log('🚀 Starting scalping bot...');

        // Main trading loop
        this.tradingInterval = setInterval(() => {
            this.tradingCycle();
        }, 7000); // 7 seconds instead of 10

        // Monitor positions
        this.monitorInterval = setInterval(() => {
            this.monitorPositions();
        }, 3000); // 3 seconds for position monitoring
    }

    stop() {
        this.isRunning = false;
        if (this.tradingInterval) clearInterval(this.tradingInterval);
        if (this.monitorInterval) clearInterval(this.monitorInterval);
        console.log('🛑 Scalping Bot Stopped');
    }

    async tradingCycle() {
        if (!this.isRunning) return;

        try {
            console.log(`\n🔄 Trading Cycle - ${new Date().toLocaleTimeString()}`);

            // Get ACTUAL open positions from Binance
            const openPositions = await this.client.getOpenPositions();
            const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

            console.log(`📊 Open Positions: ${activePositions.length}/${config.trading.maxOpenPositions}`);

            // Show current positions
            activePositions.forEach(p => {
                console.log(`   ${p.symbol}: ${parseFloat(p.positionAmt)} (PnL: ${parseFloat(p.unRealizedProfit).toFixed(2)} USDT)`);
            });

            // STRICT CHECK: Don't open new positions if at or above max
            if (activePositions.length >= config.trading.maxOpenPositions) {
                console.log(`⏸️ Max positions (${config.trading.maxOpenPositions}) reached, skipping new trades`);
                return;
            }

            // Only analyze symbols if we have room for new positions
            for (const symbol of config.trading.symbols) {
                await this.analyzeSymbol(symbol);
            }
        } catch (error) {
            console.error('❌ Trading cycle error:', error.message);
        }
    }
    async analyzeSymbol(symbol) {
        try {
            // 🆕 ADD THIS CHECK: Skip if symbol already has open position
            const openPositions = await this.client.getOpenPositions();
            const existingPosition = openPositions.find(p =>
                p.symbol === symbol && Math.abs(parseFloat(p.positionAmt)) > 0
            );

            if (existingPosition) {
                const positionSide = parseFloat(existingPosition.positionAmt) > 0 ? 'LONG' : 'SHORT';
                const pnl = parseFloat(existingPosition.unRealizedProfit).toFixed(2);
                console.log(`⏸️ ${symbol} - Skipping analysis (${positionSide} position active, PnL: ${pnl} USDT)`);
                return;
            }

            console.log(`\n🔍 Analyzing ${symbol}...`);

            // Get recent market data
            const klines = await this.client.getKlines(symbol, config.strategy.timeframe, 300);
            console.log(`   📈 Got ${klines.length} klines`);

            if (klines.length === 0) {
                console.log(`   ⚠️ No klines data for ${symbol}`);
                return;
            }

            const currentPrice = klines[klines.length - 1].close;
            console.log(`   💰 Current Price: $${currentPrice}`);

            // Analyze with strategy
            const signal = this.strategy.analyze(klines, symbol); // 🆕 Pass symbol for time-based exits
            console.log(`   🎯 Signal: ${signal.signal} - ${signal.reason}`);

            if (signal.signal !== 'HOLD') {
                console.log(`📈 ${symbol} Signal: ${signal.signal} - ${signal.reason}`);
                await this.executeTrade(symbol, signal);
            }
        } catch (error) {
            console.error(`❌ Error analyzing ${symbol}:`, error.message);
        }
    }

async executeTrade(symbol, signal) {
    try {
        const account = await this.client.getAccountInfo();
        const availableBalance = parseFloat(account.availableBalance);
        const currentPrice = signal.price;

        const openPositions = await this.client.getOpenPositions();
        const activePositions = openPositions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);

        if (activePositions.length >= config.trading.maxOpenPositions) {
            console.log(`🛑 SAFETY: Max positions reached, cancelling ${symbol} trade`);
            return;
        }

        // ADD THIS CHECK - Prevent duplicate TP/SL orders
        const hasExistingOrders = await this.checkExistingOrders(symbol);
        if (hasExistingOrders) {
            console.log(`🔄 ${symbol} Cleaning up existing orders before new trade`);
            await this.cancelTpSlOrders(symbol);
        }

        const quantity = this.strategy.calculatePositionSize(
            availableBalance,
            currentPrice,
            symbol  // Just pass symbol, strategy knows the risk config
        );

        // Adjust quantity to step size
        const symbolInfo = await this.client.getSymbolInfo(symbol);
        const adjustedQuantity = this.client.adjustQuantityToStepSize(
            quantity,
            parseFloat(symbolInfo.filters.LOT_SIZE.stepSize)
        );

        // Ensure minimum notional
        const notional = adjustedQuantity * currentPrice;
        const minNotional = parseFloat(symbolInfo.filters.MIN_NOTIONAL.notional);
        if (notional < minNotional) {
            console.log(`⏸️ ${symbol}: Notional ${notional.toFixed(2)} below minimum ${minNotional}, skipping`);
            return;
        }

        console.log(`🎯 ${symbol} Executing ${signal.signal}: ${adjustedQuantity} at ${currentPrice}`);

        // 🎯 FIX: Pass symbol to calculateLevels for pair-specific risk
        const levels = this.strategy.calculateLevels(
            currentPrice,
            signal.signal,
            symbol  // Pass symbol here
        );

        console.log(`🛡️ ${symbol} Risk Levels - Stop Loss: ${levels.stopLoss.toFixed(2)}, Take Profit: ${levels.takeProfit.toFixed(2)}`);

        // Place market order
        const order = await this.client.placeMarketOrder(symbol, signal.signal, adjustedQuantity);
        console.log(`✅ ${symbol} Order placed: ${order.orderId}`);

        // PLACE STOP LOSS AND TAKE PROFIT ORDERS
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

    } catch (error) {
        console.error(`❌ Trade execution error for ${symbol}:`, error);
    }
}

    // 🆕 NEW METHOD - Place Stop Loss and Take Profit orders
async placeStopLossAndTakeProfit(symbol, side, quantity, levels) {
    try {
        // ✅ CHECK if TP/SL orders already exist for this symbol
        const existingTpOrder = this.orders.get(`${symbol}_TP`);
        const existingSlOrder = this.orders.get(`${symbol}_SL`);

        if (existingTpOrder || existingSlOrder) {
            console.log(`⚠️ ${symbol} TP/SL orders already exist, canceling old ones`);
            await this.cancelTpSlOrders(symbol);
        }

        const symbolInfo = await this.client.getSymbolInfo(symbol);

        // 🆕 CRITICAL FIX: Orders should CLOSE the position, not open new ones!
        
        // For LONG positions (BUY) - we opened a LONG, so we need to SELL to close
        if (side === 'BUY') {
            // Take Profit - LIMIT SELL order (close long at profit)
            const tpOrder = await this.client.placeLimitOrder(
                symbol,
                'SELL',  // ✅ CLOSE the long position
                quantity,
                levels.takeProfit
            );
            console.log(`🎯 ${symbol} Take Profit set: ${tpOrder.orderId} at ${levels.takeProfit.toFixed(2)}`);

            // Stop Loss - STOP_MARKET SELL order (close long at loss)
            const slOrder = await this.client.placeStopMarketOrder(
                symbol,
                'SELL',  // ✅ CLOSE the long position  
                quantity,
                levels.stopLoss
            );
            console.log(`🛡️ ${symbol} Stop Loss set: ${slOrder.orderId} at ${levels.stopLoss.toFixed(2)}`);

            // Store TP/SL order IDs
            this.orders.set(`${symbol}_TP`, tpOrder.orderId);
            this.orders.set(`${symbol}_SL`, slOrder.orderId);

        }
        // For SHORT positions (SELL) - we opened a SHORT, so we need to BUY to close
        else if (side === 'SELL') {
            // Take Profit - LIMIT BUY order (close short at profit)
            const tpOrder = await this.client.placeLimitOrder(
                symbol,
                'BUY',   // ✅ CLOSE the short position
                quantity,
                levels.takeProfit
            );
            console.log(`🎯 ${symbol} Take Profit set: ${tpOrder.orderId} at ${levels.takeProfit.toFixed(2)}`);

            // Stop Loss - STOP_MARKET BUY order (close short at loss)
            const slOrder = await this.client.placeStopMarketOrder(
                symbol,
                'BUY',   // ✅ CLOSE the short position
                quantity,
                levels.stopLoss
            );
            console.log(`🛡️ ${symbol} Stop Loss set: ${slOrder.orderId} at ${levels.stopLoss.toFixed(2)}`);

            // Store TP/SL order IDs
            this.orders.set(`${symbol}_TP`, tpOrder.orderId);
            this.orders.set(`${symbol}_SL`, slOrder.orderId);
        }

    } catch (error) {
        console.error(`❌ Error setting TP/SL for ${symbol}:`, error.message);
    }
}

    // 🆕 Check for existing TP/SL orders on Binance
    async checkExistingOrders(symbol) {
        try {
            const openOrders = await this.client.getOpenOrders(symbol);
            const tpSlOrders = openOrders.filter(order =>
                order.type === 'LIMIT' || order.type === 'STOP_MARKET'
            );

            if (tpSlOrders.length > 0) {
                console.log(`📋 ${symbol} has ${tpSlOrders.length} existing TP/SL orders:`);
                tpSlOrders.forEach(order => {
                    console.log(`   ${order.orderId}: ${order.side} ${order.type} @ ${order.price || order.stopPrice}`);
                });
                return true;
            }
            return false;
        } catch (error) {
            console.error(`❌ Error checking existing orders for ${symbol}:`, error.message);
            return false;
        }
    }
    async monitorPositions() {
        if (!this.isRunning) return;

        try {
            const openPositions = await this.client.getOpenPositions();
            const openOrders = await this.client.getOpenOrders();

            // Check if any positions were closed by TP/SL
            for (const [positionId, position] of this.positions) {
                const stillOpen = openPositions.find(p =>
                    p.symbol === position.symbol &&
                    Math.abs(parseFloat(p.positionAmt)) > 0
                );

                if (!stillOpen) {
                    console.log(`✅ ${position.symbol} Position closed (likely by TP/SL)`);
                    // Record trade result for performance tracking
                    const exitPrice = await this.client.getLastPrice(position.symbol);
                    PerformanceTracker.recordTrade(
                        position.symbol,
                        position.side,
                        position.entryPrice,
                        exitPrice,
                        position.quantity
                    );

                    const stats = PerformanceTracker.getStats();
                    console.log(`📈 Running Stats -> Trades: ${stats.totalTrades} | Total PnL: ${stats.totalPnL} USDT | WinRate: ${stats.winRate}`);

                    // Cancel any remaining TP/SL orders
                    await this.cancelTpSlOrders(position.symbol);

                    // Remove from tracking
                    this.positions.delete(positionId);
                }
            }

        } catch (error) {
            console.error('❌ Position monitoring error:', error.message);
        }
    }

    // 🆕 Cancel TP/SL orders when position is closed
    async cancelTpSlOrders(symbol) {
        try {
            const tpOrderId = this.orders.get(`${symbol}_TP`);
            const slOrderId = this.orders.get(`${symbol}_SL`);

            let canceledCount = 0;

            if (tpOrderId) {
                try {
                    await this.client.cancelOrder(symbol, tpOrderId);
                    console.log(`🗑️ Canceled TP order: ${tpOrderId}`);
                    canceledCount++;
                } catch (error) {
                    // Order might already be filled or canceled
                    console.log(`ℹ️ TP order ${tpOrderId} already gone`);
                }
                this.orders.delete(`${symbol}_TP`);
            }

            if (slOrderId) {
                try {
                    await this.client.cancelOrder(symbol, slOrderId);
                    console.log(`🗑️ Canceled SL order: ${slOrderId}`);
                    canceledCount++;
                } catch (error) {
                    // Order might already be filled or canceled
                    console.log(`ℹ️ SL order ${slOrderId} already gone`);
                }
                this.orders.delete(`${symbol}_SL`);
            }

            // Also cancel any orphaned orders from Binance
            try {
                const openOrders = await this.client.getOpenOrders(symbol);
                const tpSlOrders = openOrders.filter(order =>
                    order.type === 'LIMIT' || order.type === 'STOP_MARKET'
                );

                for (const order of tpSlOrders) {
                    await this.client.cancelOrder(symbol, order.orderId);
                    console.log(`🗑️ Canceled orphaned order: ${order.orderId}`);
                    canceledCount++;
                }
            } catch (error) {
                console.log(`ℹ️ No orphaned orders to cancel for ${symbol}`);
            }

            if (canceledCount > 0) {
                console.log(`✅ ${symbol} Cleaned up ${canceledCount} orders`);
            }

        } catch (error) {
            console.log(`ℹ️ No TP/SL orders to cancel for ${symbol}`);
        }
    }

    async closePosition(symbol, quantity) {
        try {
            const side = quantity > 0 ? 'SELL' : 'BUY';
            const closeQuantity = Math.abs(quantity);

            // Cancel TP/SL orders first
            await this.cancelTpSlOrders(symbol);

            // Then close position
            const order = await this.client.placeMarketOrder(symbol, side, closeQuantity);
            console.log(`✅ ${symbol} Position closed: ${order.orderId}`);

        } catch (error) {
            console.error(`❌ Error closing position for ${symbol}:`, error.message);
        }
    }

    // Get bot status
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
}

module.exports = ScalpingBot;