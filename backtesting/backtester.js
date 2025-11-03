const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { createObjectCsvWriter } = require('csv-writer');
const AdvancedScalpingStrategy = require('../strategies/advancedScalping');
const config = require('../config');

class BinanceCSVBacktester {
    constructor() {
        this.strategy = new AdvancedScalpingStrategy(config);
        this.trades = [];
        this.initialBalance = 1000;
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
    }

    async runBacktest(symbol, csvFilePath, options = {}) {
        console.log(`🧪 Backtesting ${symbol} with ${csvFilePath}`);
        console.log(`⏰ Using timeframe: ${config.strategy.timeframe}`);
        
        const data = await this.loadBinanceCSVData(csvFilePath);
        
        // Resample data to match strategy timeframe if needed
        const resampledData = this.resampleData(data, config.strategy.timeframe);
        
        await this.executeBacktest(symbol, resampledData);
        await this.saveResults(symbol);
        this.printResults(symbol);
    }

loadBinanceCSVData(filePath) {
    return new Promise((resolve, reject) => {
        const results = [];
        let isFirstRow = true; // 🆕 Track first row
        
        fs.createReadStream(filePath)
            .pipe(csv({ headers: false }))
            .on('data', (data) => {
                // 🆕 SKIP THE HEADER ROW
                if (isFirstRow) {
                    isFirstRow = false;
                    console.log('📋 Skipping header row:', Object.values(data));
                    return;
                }
                
                const kline = this.parseBinanceCSVRow(data);
                if (kline) results.push(kline);
            })
            .on('end', () => {
                console.log(`📊 Loaded ${results.length} raw klines from ${filePath}`);
                results.sort((a, b) => a.time - b.time);
                resolve(results);
            })
            .on('error', reject);
    });
}

parseBinanceCSVRow(row) {
    try {
        // Handle both array format and object format from headers
        let openTime, open, high, low, close, volume;
        
        if (Array.isArray(row)) {
            // Array format: [open_time, open, high, low, close, volume, ...]
            openTime = parseInt(row[0]);
            open = parseFloat(row[1]);
            high = parseFloat(row[2]);
            low = parseFloat(row[3]);
            close = parseFloat(row[4]);
            volume = parseFloat(row[5]);
        } else {
            // Object format (from headers): { '0': '1759276800000', '1': '113988.70', ... }
            openTime = parseInt(row['0'] || row['open_time']);
            open = parseFloat(row['1'] || row['open']);
            high = parseFloat(row['2'] || row['high']);
            low = parseFloat(row['3'] || row['low']);
            close = parseFloat(row['4'] || row['close']);
            volume = parseFloat(row['5'] || row['volume']);
        }

        if (!openTime || isNaN(open) || isNaN(close)) {
            return null;
        }

        // Data validation
        if (close < 10000 || close > 200000) {
            return null;
        }

        return {
            time: openTime,
            open: open,
            high: high,
            low: low,
            close: close,
            volume: volume,
            closeTime: parseInt(row['6'] || row['close_time'])
        };
    } catch (error) {
        return null;
    }
}

    resampleData(data, targetTimeframe) {
        console.log(`🔄 Resampling from 1m to ${targetTimeframe}...`);
        
        const timeframeMinutes = this.timeframeToMinutes(targetTimeframe);
        if (timeframeMinutes === 1) {
            console.log('✅ Already using 1m data, no resampling needed');
            return data;
        }

        const resampled = [];
        let currentBucket = null;
        let bucketStartTime = null;

        for (const kline of data) {
            const klineTime = kline.time;
            
            // Check if we need to start a new bucket
            if (!currentBucket || klineTime >= bucketStartTime + (timeframeMinutes * 60 * 1000)) {
                // Save previous bucket if exists
                if (currentBucket) {
                    resampled.push(currentBucket);
                }
                
                // Start new bucket
                currentBucket = {
                    time: klineTime,
                    open: kline.open,
                    high: kline.high,
                    low: kline.low,
                    close: kline.close,
                    volume: kline.volume
                };
                bucketStartTime = klineTime;
            } else {
                // Update current bucket with new highs/lows/closes
                currentBucket.high = Math.max(currentBucket.high, kline.high);
                currentBucket.low = Math.min(currentBucket.low, kline.low);
                currentBucket.close = kline.close;
                currentBucket.volume += kline.volume;
            }
        }

        // Don't forget the last bucket
        if (currentBucket) {
            resampled.push(currentBucket);
        }

        console.log(`✅ Resampled to ${resampled.length} ${targetTimeframe} klines`);
        return resampled;
    }

    timeframeToMinutes(timeframe) {
        const unit = timeframe.slice(-1);
        const value = parseInt(timeframe.slice(0, -1));
        
        switch (unit) {
            case 'm': return value; // minutes
            case 'h': return value * 60; // hours
            case 'd': return value * 24 * 60; // days
            case 'w': return value * 7 * 24 * 60; // weeks
            default: return 1; // default to 1 minute
        }
    }

    async executeBacktest(symbol, data) {
        let positions = []; // Track multiple positions like live bot
        let equityCurve = [this.initialBalance];
        let peakEquity = this.initialBalance;

        console.log(`🎯 Starting backtest with ${data.length} klines...`);

        for (let i = 30; i < data.length; i++) {
            const currentData = data.slice(0, i + 1);
            const currentKline = data[i];
            const currentPrice = currentKline.close;

            // Get strategy signal
            const signal = this.strategy.analyze(currentData, symbol);
            
            // CHECK IF WE CAN OPEN NEW POSITION (like live bot)
            const canOpenNewPosition = positions.length < config.trading.maxOpenPositions;
            
            // ENTRY LOGIC - only if we have room and signal is valid
            if ((signal.signal === 'BUY' || signal.signal === 'SELL') && canOpenNewPosition) {
                // 🆕 FIX: Check if we already have a position for this symbol
                const existingPosition = positions.find(p => p.symbol === symbol);
                if (!existingPosition) { // 🆕 Only enter if no existing position for this symbol
                    const position = this.enterPosition(symbol, signal.signal, currentPrice, currentKline.time);
                    if (position) {
                        positions.push(position);
                        console.log(`🎯 ${new Date(currentKline.time).toISOString()} - ${position.side} ENTRY at ${currentPrice.toFixed(2)} | ${signal.reason}`);
                    }
                }
            }
            
            // EXIT LOGIC - check all open positions
            for (let j = positions.length - 1; j >= 0; j--) {
                const position = positions[j];
                const exitReason = this.checkExitConditions(position, currentKline);
                
                if (exitReason) {
                    await this.exitPosition(position, currentPrice, currentKline.time, exitReason);
                    positions.splice(j, 1); // Remove from open positions
                    
                    // Update equity curve and drawdown
                    equityCurve.push(this.balance);
                    if (this.balance > peakEquity) {
                        peakEquity = this.balance;
                    }
                    const drawdown = ((peakEquity - this.balance) / peakEquity) * 100;
                    if (drawdown > this.results.maxDrawdown) {
                        this.results.maxDrawdown = drawdown;
                    }
                }
            }

            // Progress logging
            if (i % 1000 === 0) {
                console.log(`📊 Processed ${i}/${data.length} klines | Open positions: ${positions.length}`);
            }
        }

        // Close any remaining open positions at the end
        for (const position of positions) {
            const lastPrice = data[data.length - 1].close;
            await this.exitPosition(position, lastPrice, data[data.length - 1].time, 'END_OF_DATA');
        }

        this.calculateAdvancedMetrics(equityCurve);
    }

    enterPosition(symbol, side, entryPrice, entryTime) {
        // ADD VALIDATION LIKE LIVE BOT
        const quantity = this.calculatePositionSize(this.balance, entryPrice);
        
        // Check minimum notional (like live trading)
        const minNotional = 10; // Binance futures minimum
        const notionalValue = quantity * entryPrice;
        
        if (notionalValue < minNotional) {
            console.log(`⏸️ ${symbol}: Notional ${notionalValue.toFixed(2)} below minimum ${minNotional}, skipping`);
            return null;
        }
        
        // Check if we have enough balance (including leverage)
        const positionValue = notionalValue / config.trading.leverage;
        if (positionValue > this.balance * 0.95) { // Leave some buffer
            console.log(`⏸️ ${symbol}: Insufficient balance for position, skipping`);
            return null;
        }

        return {
            symbol: symbol,
            side: side,
            entryPrice: entryPrice,
            entryTime: entryTime,
            quantity: quantity,
            entryBalance: this.balance
        };
    }

    async exitPosition(position, exitPrice, exitTime, exitReason) {
        const profit = this.calculateProfit(position, exitPrice);
        this.balance += profit;

        // 🆕 CRITICAL: Tell the strategy the position closed
        this.strategy.recordExit(position.symbol);
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
            duration: (exitTime - position.entryTime) / (1000 * 60), // minutes
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

        const timeStr = new Date(exitTime).toISOString().split('T')[1].split('.')[0];
        console.log(`💰 ${timeStr} - ${position.side} EXIT at ${exitPrice.toFixed(2)} | PnL: $${profit.toFixed(2)} | Reason: ${exitReason}`);
    }

    calculateProfit(position, exitPrice) {
        const priceDifference = exitPrice - position.entryPrice;
        let profit = position.side === 'BUY' 
            ? priceDifference * position.quantity
            : -priceDifference * position.quantity;
        
        // ADD TRADING FEES (0.04% each way for Binance futures)
        const entryFee = position.entryPrice * position.quantity * 0.0004;
        const exitFee = exitPrice * position.quantity * 0.0004;
        const totalFees = entryFee + exitFee;
        
        profit -= totalFees;
        
        return profit;
    }

    calculatePositionSize(balance, price) {
        return this.strategy.calculatePositionSize(balance, price);
    }

    checkExitConditions(position, kline) {
        const currentPrice = kline.close;
        const currentTime = kline.time;
        const levels = this.strategy.calculateLevels(position.entryPrice, position.side);
        
        const timeInTrade = (currentTime - position.entryTime) / (1000 * 60); // minutes

        // TP/SL Check
        if (position.side === 'BUY') {
            if (currentPrice >= levels.takeProfit) return 'TAKE_PROFIT';
            if (currentPrice <= levels.stopLoss) return 'STOP_LOSS';
        } else {
            if (currentPrice <= levels.takeProfit) return 'TAKE_PROFIT';
            if (currentPrice >= levels.stopLoss) return 'STOP_LOSS';
        }

        // Time-based exit (using config maxHoldTime)
        const maxHoldMinutes = (config.strategy.maxHoldTime || 300) / 60;
        if (timeInTrade > maxHoldMinutes) return 'TIME_EXIT';

        return null;
    }

    calculateAdvancedMetrics(equityCurve) {
        // Win Rate
        this.results.winRate = this.results.totalTrades > 0 
            ? (this.results.winningTrades / this.results.totalTrades) * 100 
            : 0;
        
        // Profit Factor
        const grossProfit = this.trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
        const grossLoss = Math.abs(this.trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
        this.results.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit;
        
        // Sharpe Ratio (simplified)
        const returns = equityCurve.slice(1).map((val, idx) => (val - equityCurve[idx]) / equityCurve[idx]);
        const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        const variance = returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        this.results.sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;
    }

    async saveResults(symbol) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const resultsDir = path.join(__dirname, 'results');
        
        if (!fs.existsSync(resultsDir)) {
            fs.mkdirSync(resultsDir, { recursive: true });
        }

        // Save trades to CSV
        if (this.trades.length > 0) {
            const tradesWriter = createObjectCsvWriter({
                path: path.join(resultsDir, `${symbol}-trades-${timestamp}.csv`),
                header: [
                    {id: 'id', title: 'ID'},
                    {id: 'symbol', title: 'Symbol'},
                    {id: 'side', title: 'Side'},
                    {id: 'entryPrice', title: 'Entry Price'},
                    {id: 'exitPrice', title: 'Exit Price'},
                    {id: 'quantity', title: 'Quantity'},
                    {id: 'pnl', title: 'PnL'},
                    {id: 'pnlPercent', title: 'PnL %'},
                    {id: 'entryTime', title: 'Entry Time'},
                    {id: 'exitTime', title: 'Exit Time'},
                    {id: 'duration', title: 'Duration (min)'},
                    {id: 'exitReason', title: 'Exit Reason'}
                ]
            });

            await tradesWriter.writeRecords(this.trades);
        }

        // Save summary
        const summary = {
            symbol: symbol,
            timeframe: config.strategy.timeframe,
            initialBalance: this.initialBalance,
            finalBalance: this.balance,
            totalReturn: ((this.balance - this.initialBalance) / this.initialBalance) * 100,
            ...this.results
        };

        fs.writeFileSync(
            path.join(resultsDir, `${symbol}-summary-${timestamp}.json`),
            JSON.stringify(summary, null, 2)
        );

        console.log(`💾 Results saved to ${resultsDir}`);
    }

    printResults(symbol) {
        console.log('\n' + '='.repeat(70));
        console.log('📊 BINANCE HISTORICAL BACKTEST RESULTS');
        console.log('='.repeat(70));
        console.log(`Symbol: ${symbol}`);
        console.log(`Timeframe: ${config.strategy.timeframe}`);
        console.log(`Strategy: ${config.strategy.name}`);
        console.log(`Initial Balance: $${this.initialBalance.toFixed(2)}`);
        console.log(`Final Balance: $${this.balance.toFixed(2)}`);
        console.log(`Total Return: ${((this.balance - this.initialBalance) / this.initialBalance * 100).toFixed(2)}%`);
        
        console.log('\n📈 Performance Metrics:');
        console.log(`Total Trades: ${this.results.totalTrades}`);
        console.log(`Win Rate: ${this.results.winRate.toFixed(1)}%`);
        console.log(`Profit Factor: ${this.results.profitFactor.toFixed(2)}`);
        console.log(`Sharpe Ratio: ${this.results.sharpeRatio.toFixed(2)}`);
        console.log(`Max Drawdown: ${this.results.maxDrawdown.toFixed(2)}%`);
        console.log(`Largest Win: $${this.results.largestWin.toFixed(2)}`);
        console.log(`Largest Loss: $${this.results.largestLoss.toFixed(2)}`);
        console.log(`Average Trade: $${this.results.totalTrades > 0 ? (this.results.totalProfit / this.results.totalTrades).toFixed(2) : 0}`);
        
        // Trade duration stats
        if (this.trades.length > 0) {
            const avgDuration = this.trades.reduce((sum, t) => sum + t.duration, 0) / this.trades.length;
            console.log(`Average Trade Duration: ${avgDuration.toFixed(1)} minutes`);
        }
        
        console.log('='.repeat(70));
    }
}

module.exports = BinanceCSVBacktester;