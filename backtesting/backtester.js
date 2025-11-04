const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const SimpleScalpingStrategy = require('../strategies/simpleScalping');
const config = require('../config');

class BinanceCSVBacktester {
    constructor() {
        this.strategy = new SimpleScalpingStrategy(config);
        this.trades = [];
        this.initialBalance = 5000;
        this.balance = this.initialBalance;
        this.results = {
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            totalProfit: 0,
            maxDrawdown: 0,
            largestWin: 0,
            largestLoss: 0,
            winRate: 0,
            profitFactor: 0,
            sharpeRatio: 0
        };
        this.symbolResults = new Map();
        this.openPositions = new Map();
        this.currentCycle = 0;
        this.equityCurve = [this.initialBalance];
        this.peakEquity = this.initialBalance;
    }

    async runMultiBacktest(symbolFileMap, options = {}) {
        console.log(`🧪 MULTI-PAIR BACKTESTING STARTING`);
        console.log(`📊 Testing ${Object.keys(symbolFileMap).length} pairs: ${Object.keys(symbolFileMap).join(', ')}`);
        console.log(`🎯 Max Open Positions: ${config.trading.maxOpenPositions}`);

        // Load all data first
        const allData = new Map();
        
        for (const [symbol, filePath] of Object.entries(symbolFileMap)) {
            console.log(`\n📖 Loading data for ${symbol}...`);
            const data = await this.loadBinanceCSVData(filePath, symbol);
            
            if (data.length === 0) {
                console.log(`❌ No data loaded for ${symbol}, skipping`);
                continue;
            }

            const detectedTimeframe = this.detectSourceTimeframe(data);
            console.log(`📊 ${symbol}: ${data.length} klines, detected timeframe: ${detectedTimeframe}`);

            let processedData = data;
            if (detectedTimeframe !== config.strategy.timeframe) {
                console.log(`🔄 ${symbol}: Resampling from ${detectedTimeframe} to ${config.strategy.timeframe}...`);
                processedData = this.resampleData(data, config.strategy.timeframe);
            } else {
                console.log(`✅ ${symbol}: Using ${detectedTimeframe} data directly`);
            }

            allData.set(symbol, processedData);
        }

        if (allData.size === 0) {
            console.log('❌ No valid data loaded for any symbol');
            return;
        }

        // Find common timeline
        const commonTimeline = this.createCommonTimeline(allData);
        console.log(`\n⏰ Common timeline: ${commonTimeline.length} trading cycles`);

        const originalBalance = this.balance;
        
        // Execute trading cycles
        await this.executeTradingCycles(allData, commonTimeline);
        
        // Calculate final metrics
        this.calculateAdvancedMetrics(this.equityCurve);
        
        // Print summary
        this.printMultiPairSummary(originalBalance);
    }

    createCommonTimeline(allData) {
        const timelines = [];
        
        for (const [symbol, data] of allData.entries()) {
            const symbolTimeline = data.map(kline => kline.time);
            timelines.push(symbolTimeline);
        }

        // Find intersection of all timelines
        let commonTimeline = timelines[0];
        for (let i = 1; i < timelines.length; i++) {
            commonTimeline = commonTimeline.filter(time => 
                timelines[i].includes(time)
            );
        }

        console.log(`📅 Common timeline: ${commonTimeline.length} data points`);
        if (commonTimeline.length > 0) {
            console.log(`📅 Date range: ${new Date(commonTimeline[0]).toISOString()} to ${new Date(commonTimeline[commonTimeline.length - 1]).toISOString()}`);
        }
        
        return commonTimeline;
    }

    async executeTradingCycles(allData, timeline) {
        let cycleCount = 0;
        let totalSignals = 0;
        
        console.log(`\n🚀 Starting trading cycle simulation...`);
        console.log(`📊 ${timeline.length} total cycles to process`);

        for (let cycleIndex = 0; cycleIndex < timeline.length; cycleIndex++) {
            this.currentCycle = cycleIndex;
            const currentTime = timeline[cycleIndex];
            
            if (cycleIndex % 200 === 0) {
                console.log(`\n🔄 Cycle ${cycleIndex}/${timeline.length} - ${new Date(currentTime).toISOString()}`);
                console.log(`   📊 Open Positions: ${this.openPositions.size}/${config.trading.maxOpenPositions}`);
                console.log(`   💰 Current Balance: $${this.balance.toFixed(2)}`);
                console.log(`   📈 Total Signals: ${totalSignals}`);
                console.log(`   💼 Total Trades: ${this.trades.length}`);
            }

            // Check exit conditions for all open positions first
            const exitedPositions = await this.checkAndExitPositions(allData, currentTime);
            
            // Only analyze new symbols if we have room
            if (this.openPositions.size < config.trading.maxOpenPositions) {
                const symbols = Array.from(allData.keys());
                
                let signalsThisCycle = 0;
                for (const symbol of symbols) {
                    // Skip if this symbol already has an open position
                    if (this.hasOpenPosition(symbol)) {
                        continue;
                    }

                    // Skip if we've reached max positions during this cycle
                    if (this.openPositions.size >= config.trading.maxOpenPositions) {
                        break;
                    }

                    const signalFound = await this.analyzeSymbolInCycle(symbol, allData.get(symbol), currentTime, cycleIndex);
                    if (signalFound) {
                        signalsThisCycle++;
                        totalSignals++;
                    }
                }

                if (signalsThisCycle > 0 && cycleIndex % 200 === 0) {
                    console.log(`   📡 Found ${signalsThisCycle} signals this cycle`);
                }
            }

            // Update equity curve
            this.equityCurve.push(this.balance);
            if (this.balance > this.peakEquity) {
                this.peakEquity = this.balance;
            }
            
            cycleCount++;
        }

        // Close any remaining positions at end
        await this.closeAllPositions(allData, timeline[timeline.length - 1]);
        
        console.log(`\n✅ Completed ${cycleCount} trading cycles`);
        console.log(`📈 Total signals detected: ${totalSignals}`);
        console.log(`💼 Total trades executed: ${this.trades.length}`);
    }

    async checkAndExitPositions(allData, currentTime) {
        const positionsToClose = [];

        for (const [symbol, position] of this.openPositions.entries()) {
            const symbolData = allData.get(symbol);
            if (!symbolData) continue;

            // Find the kline for current time
            const currentKline = symbolData.find(k => k.time === currentTime);
            if (!currentKline) continue;

            const exitReason = this.checkExitConditions(position, currentKline);
            if (exitReason) {
                positionsToClose.push({ symbol, position, currentPrice: currentKline.close, exitReason });
            }
        }

        // Close positions that hit exit conditions
        for (const { symbol, position, currentPrice, exitReason } of positionsToClose) {
            await this.exitPosition(position, currentPrice, currentTime, exitReason);
            this.openPositions.delete(symbol);
            
            if (this.currentCycle % 200 === 0) {
                console.log(`   🏁 ${symbol} position closed: ${exitReason}`);
            }
        }

        return positionsToClose.length;
    }

    async analyzeSymbolInCycle(symbol, data, currentTime, cycleIndex) {
        try {
            // 🎯 USE ALL AVAILABLE DATA UP TO CURRENT POINT (not just 100 candles)
            const currentData = data.slice(0, cycleIndex + 1);
            
            // Need at least 100 candles for indicators to be reliable
            if (currentData.length < 100) {
                return false; // Not enough data for analysis
            }

            const currentKline = currentData[currentData.length - 1];
            const currentPrice = currentKline.close;

            // Analyze with strategy - PASS ALL HISTORICAL DATA
            const signal = this.strategy.analyze(currentData, symbol);
            
            if (signal.signal !== 'HOLD') {
                if (this.currentCycle % 200 === 0) {
                    console.log(`   📡 ${symbol}: ${signal.signal} at $${currentPrice.toFixed(2)} - ${signal.reason}`);
                    console.log(`   📊 Using ${currentData.length} candles for analysis`);
                }
                
                const position = await this.enterPosition(symbol, signal.signal, currentPrice, currentTime);
                return position !== null;
            }
            
            return false;
        } catch (error) {
            console.error(`❌ Error analyzing ${symbol} in cycle:`, error.message);
            return false;
        }
    }

    async enterPosition(symbol, side, entryPrice, entryTime) {
        // Double-check position limits
        if (this.openPositions.size >= config.trading.maxOpenPositions) {
            return null;
        }

        if (this.hasOpenPosition(symbol)) {
            return null;
        }

        // Use strategy's position sizing
        const quantity = this.strategy.calculatePositionSize(
            this.balance,
            entryPrice
        );

        if (quantity <= 0) {
            return null;
        }

        const position = {
            symbol: symbol,
            side: side,
            entryPrice: entryPrice,
            entryTime: entryTime,
            quantity: quantity,
            leverage: config.trading.leverage,
            marginUsed: quantity * entryPrice / config.trading.leverage,
            entryBalance: this.balance,
            levels: this.strategy.calculateLevels(entryPrice, side)
        };

        this.openPositions.set(symbol, position);
        
        if (this.currentCycle % 200 === 0) {
            console.log(`   🎯 ${symbol} ENTERED ${side} at $${entryPrice.toFixed(2)}`);
            console.log(`      Quantity: ${quantity.toFixed(6)} | Risk: $${(quantity * entryPrice).toFixed(2)}`);
        }

        return position;
    }

    hasOpenPosition(symbol) {
        return this.openPositions.has(symbol);
    }

    async closeAllPositions(allData, endTime) {
        console.log(`\n🔚 Closing all remaining positions at end of backtest...`);
        
        let closedCount = 0;
        for (const [symbol, position] of this.openPositions.entries()) {
            const symbolData = allData.get(symbol);
            if (!symbolData) continue;

            const lastKline = symbolData[symbolData.length - 1];
            await this.exitPosition(position, lastKline.close, endTime, 'END_OF_BACKTEST');
            closedCount++;
        }
        
        this.openPositions.clear();
        console.log(`✅ Closed ${closedCount} remaining positions`);
    }

    checkExitConditions(position, kline) {
        const currentPrice = kline.close;
        const { stopLoss, takeProfit } = position.levels;

        if (position.side === 'BUY') {
            if (currentPrice >= takeProfit) return 'TAKE_PROFIT';
            if (currentPrice <= stopLoss) return 'STOP_LOSS';
        } else {
            if (currentPrice <= takeProfit) return 'TAKE_PROFIT';
            if (currentPrice >= stopLoss) return 'STOP_LOSS';
        }

        // Time-based exit
        const holdTime = kline.time - position.entryTime;
        const maxHoldTime = config.strategy.maxHoldTime || (8 * 60 * 60 * 1000);
        
        if (holdTime >= maxHoldTime) {
            return 'MAX_HOLD_TIME_REACHED';
        }

        return null;
    }

    async exitPosition(position, exitPrice, exitTime, exitReason) {
        const profit = this.calculateProfit(position, exitPrice);
        this.balance += profit;

        const trade = {
            id: this.trades.length + 1,
            symbol: position.symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice: exitPrice,
            quantity: position.quantity,
            pnl: profit,
            pnlPercent: (profit / position.entryBalance) * 100,
            entryTime: new Date(position.entryTime).toISOString(),
            exitTime: new Date(exitTime).toISOString(),
            duration: (exitTime - position.entryTime) / (1000 * 60),
            exitReason: exitReason
        };

        this.trades.push(trade);

        // Update results
        this.results.totalTrades++;
        if (profit > 0) {
            this.results.winningTrades++;
            if (profit > this.results.largestWin) this.results.largestWin = profit;
        } else {
            this.results.losingTrades++;
            if (profit < this.results.largestLoss) this.results.largestLoss = profit;
        }
        this.results.totalProfit += profit;

        if (this.currentCycle % 200 === 0) {
            const timeStr = new Date(exitTime).toISOString().split('T')[1].split('.')[0];
            console.log(`   💰 ${position.symbol} EXIT at $${exitPrice.toFixed(2)} | PnL: $${profit.toFixed(2)} | Reason: ${exitReason}`);
        }
    }

    calculateProfit(position, exitPrice) {
        const priceDifference = exitPrice - position.entryPrice;
        
        let grossProfit;
        if (position.side === 'BUY') {
            grossProfit = priceDifference * position.quantity;
        } else {
            grossProfit = -priceDifference * position.quantity;
        }
        
        // Apply leverage
        grossProfit *= position.leverage;
        
        // Fees (0.04% each way)
        const entryValue = position.quantity * position.entryPrice;
        const exitValue = position.quantity * exitPrice;
        const entryFee = entryValue * 0.0004;
        const exitFee = exitValue * 0.0004;
        const totalFees = entryFee + exitFee;
        
        const netProfit = grossProfit - totalFees;
        return netProfit;
    }

    calculateAdvancedMetrics(equityCurve) {
        this.results.winRate = this.results.totalTrades > 0
            ? (this.results.winningTrades / this.results.totalTrades) * 100
            : 0;

        const grossProfit = this.trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
        const grossLoss = Math.abs(this.trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
        this.results.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

        // Calculate returns and Sharpe ratio
        const returns = [];
        for (let i = 1; i < equityCurve.length; i++) {
            returns.push((equityCurve[i] - equityCurve[i-1]) / equityCurve[i-1]);
        }
        
        const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        const variance = returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        this.results.sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

        // Calculate max drawdown
        let maxDrawdown = 0;
        let peak = equityCurve[0];
        for (let i = 1; i < equityCurve.length; i++) {
            if (equityCurve[i] > peak) {
                peak = equityCurve[i];
            }
            const drawdown = ((peak - equityCurve[i]) / peak) * 100;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }
        this.results.maxDrawdown = maxDrawdown;
    }

    printMultiPairSummary(originalBalance) {
        const totalReturn = ((this.balance - originalBalance) / originalBalance) * 100;
        const totalProfit = this.balance - originalBalance;
        
        // Group trades by symbol
        const symbolTrades = new Map();
        for (const trade of this.trades) {
            if (!symbolTrades.has(trade.symbol)) {
                symbolTrades.set(trade.symbol, []);
            }
            symbolTrades.get(trade.symbol).push(trade);
        }
        
        // Calculate symbol-specific results
        for (const [symbol, trades] of symbolTrades.entries()) {
            const symbolProfit = trades.reduce((sum, t) => sum + t.pnl, 0);
            const winningTrades = trades.filter(t => t.pnl > 0).length;
            const losingTrades = trades.filter(t => t.pnl <= 0).length;
            const winRate = trades.length > 0 ? (winningTrades / trades.length) * 100 : 0;
            
            this.symbolResults.set(symbol, {
                trades: trades.length,
                winningTrades: winningTrades,
                losingTrades: losingTrades,
                winRate: winRate,
                totalProfit: symbolProfit,
                profit: symbolProfit
            });
        }

        console.log(`\n${'='.repeat(80)}`);
        console.log('🎉 MULTI-PAIR BACKTEST COMPLETED - FINAL SUMMARY');
        console.log('='.repeat(80));
        console.log(`💰 Initial Balance: $${originalBalance.toFixed(2)}`);
        console.log(`💰 Final Balance: $${this.balance.toFixed(2)}`);
        console.log(`📈 Total Return: ${totalReturn.toFixed(2)}%`);
        console.log(`💰 Total Profit: $${totalProfit.toFixed(2)}`);
        console.log(`📊 Total Trades: ${this.results.totalTrades}`);
        console.log(`🎯 Win Rate: ${this.results.winRate.toFixed(1)}%`);
        console.log(`🔄 Total Trading Cycles: ${this.currentCycle}`);
        console.log(`📉 Max Drawdown: ${this.results.maxDrawdown.toFixed(2)}%`);
        console.log(`📈 Profit Factor: ${this.results.profitFactor.toFixed(2)}`);
        console.log('='.repeat(80));
        
        if (this.symbolResults.size > 0) {
            console.log('\n📈 INDIVIDUAL SYMBOL PERFORMANCE:');
            console.log('-'.repeat(80));
            console.log('Symbol     | Return    | Profit    | Trades | Win Rate | Wins | Losses');
            console.log('-'.repeat(80));
            
            for (const [symbol, result] of this.symbolResults.entries()) {
                const returnPercent = (result.profit / originalBalance) * 100;
                console.log(
                    `${symbol.padEnd(10)} | ` +
                    `${returnPercent.toFixed(2)}%`.padEnd(9) + ' | ' +
                    `$${result.profit.toFixed(2)}`.padEnd(9) + ' | ' +
                    `${result.trades}`.padEnd(7) + ' | ' +
                    `${result.winRate.toFixed(1)}%`.padEnd(8) + ' | ' +
                    `${result.winningTrades}`.padEnd(5) + ' | ' +
                    `${result.losingTrades}`
                );
            }
            console.log('-'.repeat(80));
        }

        // Performance analysis
        console.log('\n🔍 PERFORMANCE ANALYSIS:');
        console.log('-'.repeat(50));
        
        const profitableSymbols = Array.from(this.symbolResults.entries())
            .filter(([symbol, result]) => result.profit > 0)
            .map(([symbol, result]) => symbol);
            
        const losingSymbols = Array.from(this.symbolResults.entries())
            .filter(([symbol, result]) => result.profit <= 0)
            .map(([symbol, result]) => symbol);
            
        console.log(`✅ Profitable Symbols: ${profitableSymbols.length > 0 ? profitableSymbols.join(', ') : 'None'}`);
        console.log(`❌ Losing Symbols: ${losingSymbols.length > 0 ? losingSymbols.join(', ') : 'None'}`);
        
        if (this.symbolResults.size > 0) {
            const sortedByProfit = Array.from(this.symbolResults.entries())
                .sort((a, b) => b[1].profit - a[1].profit);
                
            console.log(`🏆 Best Performer: ${sortedByProfit[0][0]} ($${sortedByProfit[0][1].profit.toFixed(2)})`);
            console.log(`📉 Worst Performer: ${sortedByProfit[sortedByProfit.length - 1][0]} ($${sortedByProfit[sortedByProfit.length - 1][1].profit.toFixed(2)})`);
        }
        
        console.log('='.repeat(80));
    }

    detectSourceTimeframe(data) {
        if (data.length < 2) return '1m';
        const timeDiffs = [];
        for (let i = 1; i < Math.min(data.length, 10); i++) {
            timeDiffs.push(data[i].time - data[i - 1].time);
        }
        const avgDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
        const avgMinutes = avgDiff / (60 * 1000);
        if (avgMinutes >= 1400) return '1d';
        if (avgMinutes >= 350) return '4h';
        if (avgMinutes >= 55) return '1h';
        if (avgMinutes >= 13) return '15m';
        if (avgMinutes >= 4.5) return '5m';
        if (avgMinutes >= 2.5) return '3m';
        if (avgMinutes >= 0.5) return '1m';
        return '1m';
    }

    loadBinanceCSVData(filePath, symbol) {
        return new Promise((resolve, reject) => {
            const results = [];
            let isFirstRow = true;
            let rowCount = 0;
            let validKlines = 0;

            console.log(`\n📖 Reading CSV file for ${symbol}: ${filePath}`);
            
            if (!fs.existsSync(filePath)) {
                console.log(`❌ File not found: ${filePath}`);
                resolve([]);
                return;
            }

            fs.createReadStream(filePath)
                .pipe(csv({ headers: false, skipEmptyLines: true }))
                .on('data', (data) => {
                    rowCount++;
                    if (isFirstRow) {
                        isFirstRow = false;
                        const firstValue = Object.values(data)[0];
                        if (typeof firstValue === 'string' && 
                            (firstValue.toLowerCase().includes('time') || 
                             firstValue.toLowerCase().includes('open') ||
                             isNaN(parseInt(firstValue)))) {
                            return;
                        }
                    }

                    const kline = this.parseBinanceCSVRow(data, symbol);
                    if (kline) {
                        results.push(kline);
                        validKlines++;
                    }
                })
                .on('end', () => {
                    console.log(`📊 Loaded ${validKlines} valid klines from ${rowCount} total rows for ${symbol}`);
                    results.sort((a, b) => a.time - b.time);
                    resolve(results);
                })
                .on('error', reject);
        });
    }

    parseBinanceCSVRow(row, symbol) {
        try {
            const values = Array.isArray(row) ? row : Object.values(row);
            if (values.length < 6) return null;

            const openTime = parseInt(values[0]);
            const open = parseFloat(values[1]);
            const high = parseFloat(values[2]);
            const low = parseFloat(values[3]);
            const close = parseFloat(values[4]);
            const volume = parseFloat(values[5]);

            if (!openTime || openTime < 1000000000000) return null;
            if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) return null;
            if (close <= 0) return null;

            return {
                time: openTime,
                open: open,
                high: high,
                low: low,
                close: close,
                volume: volume,
                closeTime: parseInt(values[6] || 0)
            };
        } catch (error) {
            return null;
        }
    }

    resampleData(data, targetTimeframe) {
        if (data.length === 0) return data;
        const detectedTimeframe = this.detectSourceTimeframe(data);
        const targetMinutes = this.timeframeToMinutes(targetTimeframe);
        const sourceMinutes = this.timeframeToMinutes(detectedTimeframe);

        if (targetMinutes === sourceMinutes) return data;
        if (targetMinutes < sourceMinutes) {
            console.log(`❌ Cannot resample from ${detectedTimeframe} to ${targetTimeframe}`);
            return data;
        }

        const resampled = [];
        let currentBucket = null;
        let bucketStartTime = null;

        for (const kline of data) {
            if (!currentBucket || kline.time >= bucketStartTime + (targetMinutes * 60 * 1000)) {
                if (currentBucket) resampled.push(currentBucket);
                currentBucket = { ...kline };
                bucketStartTime = kline.time;
            } else {
                currentBucket.high = Math.max(currentBucket.high, kline.high);
                currentBucket.low = Math.min(currentBucket.low, kline.low);
                currentBucket.close = kline.close;
                currentBucket.volume += kline.volume;
            }
        }
        if (currentBucket) resampled.push(currentBucket);

        console.log(`✅ Resampled from ${data.length} to ${resampled.length} klines`);
        return resampled;
    }

    timeframeToMinutes(timeframe) {
        const unit = timeframe.slice(-1);
        const value = parseInt(timeframe.slice(0, -1));
        switch (unit) {
            case 'm': return value;
            case 'h': return value * 60;
            case 'd': return value * 24 * 60;
            case 'w': return value * 7 * 24 * 60;
            default: return 1;
        }
    }
}

module.exports = BinanceCSVBacktester;