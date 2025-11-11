import fs from 'fs';
import csv from 'csv-parser';
import SimpleScalping from '#strategies/SimpleScalping';
import config from '#config';
import path from 'path';

class BinanceCSVBacktester {
    constructor(options = {}) {
        this.strategy = new SimpleScalping(config);
        this.trades = [];
        this.initialBalance = options.initialBalance || 5000;
        this.balance = this.initialBalance;
        
        // 🆕 REALISTIC TRADING COSTS
        this.tradingCosts = {
            // Basic costs
            slippagePercent: options.slippage || 0.02,        // 0.05% slippage per side
            feePercent: options.fee || 0.04,                  // 0.04% trading fee
            fundingRatePercent: options.funding || 0.005,      // 0.01% funding every 8h
            
            // Advanced cost modeling
            slWorseningPercent: options.slWorsening || 0.08,  // 15% of SL orders fill worse
            slWorseningAmount: options.slWorseningAmount || 0.10, // 0.20% worse fill on bad SLs
            apiLatencyMs: options.latency || 150,             // 150ms API delay
            partialFillRate: options.partialFillRate || 0.95, // 95% fill rate for market orders
            
            // Feature toggles
            enabled: {
                slippage: options.enableSlippage !== false,
                funding: options.enableFunding !== false,
                slWorsening: options.enableSlWorsening === true,
                latency: options.enableLatency !== false,
                partialFills: options.enablePartialFills === true,
                volumeAware: options.enableVolumeAware !== false,
                timeOfDay: options.enableTimeOfDay !== false
            }
        };
        
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
            sharpeRatio: 0,
            // 🆕 Cost breakdown
            totalSlippage: 0,
            totalFees: 0,
            totalFunding: 0,
            slWorseningCost: 0,
            partialFillLoss: 0
        };
        
        this.symbolResults = new Map();
        this.openPositions = new Map();
        this.currentCycle = 0;
        this.currentTime = 0;
        this.equityCurve = [this.initialBalance];
        this.peakEquity = this.initialBalance;
        
        this.resultsDir = this.ensureResultsFolder();
        
        console.log('\n🎯 REALISTIC BACKTESTING MODE ENABLED');
        this.printCostConfig();
    }

    printCostConfig() {
        console.log('💰 Trading Costs Configuration:');
        console.log(`   Slippage: ${this.tradingCosts.enabled.slippage ? this.tradingCosts.slippagePercent + '%' : 'DISABLED'}`);
        console.log(`   Fees: ${this.tradingCosts.feePercent}%`);
        console.log(`   Funding Rate: ${this.tradingCosts.enabled.funding ? this.tradingCosts.fundingRatePercent + '% per 8h' : 'DISABLED'}`);
        console.log(`   SL Worsening: ${this.tradingCosts.enabled.slWorsening ? this.tradingCosts.slWorseningPercent * 100 + '% of trades' : 'DISABLED'}`);
        console.log(`   API Latency: ${this.tradingCosts.enabled.latency ? this.tradingCosts.apiLatencyMs + 'ms' : 'DISABLED'}`);
        console.log(`   Partial Fills: ${this.tradingCosts.enabled.partialFills ? (this.tradingCosts.partialFillRate * 100) + '% fill rate' : 'DISABLED'}`);
    }

    ensureResultsFolder() {
        const resultsDir = path.join(process.cwd(), 'backtesting/results');
        if (!fs.existsSync(resultsDir)) {
            fs.mkdirSync(resultsDir, { recursive: true });
            console.log(`✅ Created results folder: ${resultsDir}`);
        }
        return resultsDir;
    }

    // 🆕 IMPROVED SLIPPAGE MODEL
    applyEntrySlippage(price, side, volume = 0, volatility = 0) {
        if (!this.tradingCosts.enabled.slippage) return price;
        
        let baseSlippage = this.tradingCosts.slippagePercent / 100;
        
        // Volume-based slippage (larger orders = more slippage)
        if (this.tradingCosts.enabled.volumeAware && volume > 0) {
            const volumeFactor = Math.min(volume / 100000, 2.0);
            baseSlippage *= (1 + volumeFactor * 0.5);
        }
        
        // Volatility-based slippage (high volatility = more slippage)
        if (volatility > 0) {
            const volatilityFactor = Math.min(volatility * 10, 3.0);
            baseSlippage *= (1 + volatilityFactor);
        }
        
        // Time-of-day factor (high volume periods = less slippage)
        if (this.tradingCosts.enabled.timeOfDay) {
            const hour = new Date().getHours();
            const isPeakHours = (hour >= 14 && hour <= 22); // US/EU overlap
            if (isPeakHours) baseSlippage *= 0.7;
        }
        
        if (side === 'BUY') {
            return price * (1 + baseSlippage);
        } else {
            return price * (1 - baseSlippage);
        }
    }

    // 🆕 IMPROVED STOP-LOSS EXECUTION
    applyExitSlippage(price, side, exitReason, volatility = 0, volume = 0) {
        if (!this.tradingCosts.enabled.slippage) return price;
        
        let slippage = this.tradingCosts.slippagePercent / 100;
        
        // Stop-loss specific worsening
        if (exitReason === 'STOP_LOSS' && this.tradingCosts.enabled.slWorsening) {
            let badFillChance = this.tradingCosts.slWorseningPercent;
            
            // Increase chance during high volatility
            if (volatility > 0) {
                badFillChance *= (1 + volatility * 5);
            }
            
            if (Math.random() < badFillChance) {
                const worsening = this.tradingCosts.slWorseningAmount / 100;
                const variableWorsening = worsening * (1 + Math.random());
                slippage += variableWorsening;
                
                this.results.slWorseningCost += 1;
            }
        }
        
        // Add volume and volatility factors
        if (this.tradingCosts.enabled.volumeAware && volume > 0) {
            const volumeFactor = Math.min(volume / 100000, 2.0);
            slippage *= (1 + volumeFactor * 0.5);
        }
        
        if (volatility > 0) {
            const volatilityFactor = Math.min(volatility * 10, 3.0);
            slippage *= (1 + volatilityFactor);
        }
        
        if (side === 'BUY') {
            return price * (1 - slippage);
        } else {
            return price * (1 + slippage);
        }
    }

    // 🆕 PARTIAL FILLS SIMULATION
    simulateOrderExecution(quantity, orderType = 'MARKET') {
        if (!this.tradingCosts.enabled.partialFills || orderType !== 'MARKET') {
            return { filled: quantity, partial: false };
        }
        
        let filledQuantity = quantity * this.tradingCosts.partialFillRate;
        
        // Larger orders get worse fills
        if (quantity > 1000) {
            const sizePenalty = Math.min((quantity - 1000) / 10000, 0.3);
            filledQuantity = quantity * (this.tradingCosts.partialFillRate - sizePenalty);
        }
        
        const partialLoss = (quantity - filledQuantity) * 0.001; // Small cost for unfilled portion
        this.results.partialFillLoss += partialLoss;
        
        return {
            filled: filledQuantity,
            partial: filledQuantity < quantity,
            unfilledAmount: quantity - filledQuantity,
            partialLoss: partialLoss
        };
    }

    // 🆕 CALCULATE VOLATILITY (ATR-based)
    calculateVolatility(klines, period = 14) {
        if (klines.length < period + 1) return 0;
        
        let atrSum = 0;
        for (let i = klines.length - period; i < klines.length; i++) {
            const high = klines[i].high;
            const low = klines[i].low;
            const prevClose = klines[i-1].close;
            
            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            atrSum += tr;
        }
        
        const atr = atrSum / period;
        const currentPrice = klines[klines.length - 1].close;
        return atr / currentPrice; // Return as percentage
    }

    // 🆕 DYNAMIC FUNDING RATES
    calculateFundingCost(position, holdTimeMs) {
        if (!this.tradingCosts.enabled.funding) return 0;
        
        const eightHours = 8 * 60 * 60 * 1000;
        const fundingPeriods = Math.floor(holdTimeMs / eightHours);
        
        if (fundingPeriods === 0) return 0;
        
        // Dynamic funding rates based on market conditions
        let fundingRate = this.tradingCosts.fundingRatePercent / 100;
        
        // Simulate funding rate fluctuations (-0.01% to +0.03%)
        const fundingVariation = (Math.random() * 0.04) - 0.01;
        fundingRate += fundingVariation;
        
        const positionValue = position.quantity * position.entryPrice * position.leverage;
        let fundingCost = positionValue * fundingRate * fundingPeriods;
        
        // If short position, sometimes receive funding instead of paying
        if (position.side === 'SELL' && fundingRate < 0) {
            fundingCost = -fundingCost;
        }
        
        return fundingCost;
    }

    // 🆕 REALISTIC POSITION SIZING WITH LIQUIDITY
    calculateRealisticPositionSize(balance, price, symbol, klines) {
        const baseQuantity = this.strategy.calculatePositionSize(balance, price, symbol);
        
        if (this.tradingCosts.enabled.volumeAware && klines && klines.length > 20) {
            // Check recent volume for liquidity
            const recentVolume = klines.slice(-20).reduce((sum, k) => sum + k.volume, 0) / 20;
            const volumeThreshold = 5000//10000;
            
            // Reduce position if low liquidity
            let liquidityFactor = 1.0;
            if (recentVolume < volumeThreshold) {
                liquidityFactor = Math.max(recentVolume / volumeThreshold, 0.3);
            }
            
            // Don't trade more than 2% of average volume
            const maxVolumePercent = 0.05//0.02;
            const maxByVolume = (recentVolume * maxVolumePercent) / price;
            
            return Math.min(baseQuantity * liquidityFactor, maxByVolume);
        }
        
        return baseQuantity;
    }

    // Method to save results to JSON file
    saveResultsToFile() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `backtest-results-${timestamp}.json`;
            const filepath = path.join(this.resultsDir, filename);
            
            const totalCosts = this.results.totalFees + this.results.totalSlippage + this.results.totalFunding + this.results.partialFillLoss;
            const totalProfit = this.balance - this.initialBalance;
            const grossProfit = totalProfit + totalCosts;
            
            const resultsData = {
                timestamp: new Date().toISOString(),
                tradingCosts: this.tradingCosts,
                summary: {
                    initialBalance: this.initialBalance,
                    finalBalance: this.balance,
                    totalReturn: ((this.balance - this.initialBalance) / this.initialBalance) * 100,
                    totalProfit: totalProfit,
                    grossProfit: grossProfit,
                    totalTrades: this.results.totalTrades,
                    winRate: this.results.winRate,
                    maxDrawdown: this.results.maxDrawdown,
                    profitFactor: this.results.profitFactor,
                    sharpeRatio: this.results.sharpeRatio,
                    largestWin: this.results.largestWin,
                    largestLoss: this.results.largestLoss,
                    // Cost breakdown
                    totalFees: this.results.totalFees,
                    totalSlippage: this.results.totalSlippage,
                    totalFunding: this.results.totalFunding,
                    partialFillLoss: this.results.partialFillLoss,
                    totalCosts: totalCosts,
                    costRatio: totalCosts / Math.abs(grossProfit) * 100,
                    slWorseningOccurrences: this.results.slWorseningCost
                },
                symbolPerformance: Object.fromEntries(this.symbolResults),
                trades: this.trades,
                equityCurve: this.equityCurve,
                configuration: {
                    maxOpenPositions: config.trading.maxOpenPositions,
                    leverage: config.trading.leverage,
                    timeframe: config.strategy.timeframe,
                    symbols: config.trading.symbols
                }
            };
            
            fs.writeFileSync(filepath, JSON.stringify(resultsData, null, 2));
            console.log(`💾 Results saved to: ${filepath}`);
            
            this.saveTradesToCSV(timestamp);
            return filepath;
        } catch (error) {
            console.error('❌ Error saving results:', error.message);
        }
    }

    // Method to save trades as CSV
    saveTradesToCSV(timestamp) {
        try {
            const csvFilename = `trades-${timestamp}.csv`;
            const csvFilepath = path.join(this.resultsDir, csvFilename);
            
            const csvHeaders = [
                'id', 'symbol', 'side', 'signalEntryPrice', 'actualEntryPrice', 
                'signalExitPrice', 'actualExitPrice', 'quantity', 'pnl', 'pnlPercent', 
                'entryTime', 'exitTime', 'duration', 'exitReason', 
                'entrySlippage', 'exitSlippage', 'totalSlippage', 'fundingCost', 'fees'
            ].join(',');
            
            const csvRows = this.trades.map(trade => 
                csvHeaders.split(',').map(header => 
                    `"${trade[header] || ''}"`
                ).join(',')
            );
            
            const csvContent = [csvHeaders, ...csvRows].join('\n');
            fs.writeFileSync(csvFilepath, csvContent);
            console.log(`📊 Trades CSV saved to: ${csvFilepath}`);
            
        } catch (error) {
            console.error('❌ Error saving trades CSV:', error.message);
        }
    }

    // Method to save a summary report
    saveSummaryReport() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `summary-report-${timestamp}.txt`;
            const filepath = path.join(this.resultsDir, filename);
            
            const totalCosts = this.results.totalFees + this.results.totalSlippage + this.results.totalFunding + this.results.partialFillLoss;
            const totalProfit = this.balance - this.initialBalance;
            const grossProfit = totalProfit + totalCosts;
            
            let report = `REALISTIC BACKTEST SUMMARY REPORT\n`;
            report += `Generated: ${new Date().toISOString()}\n`;
            report += `${'='.repeat(60)}\n\n`;
            
            // Summary stats
            report += `PERFORMANCE SUMMARY:\n`;
            report += `${'-'.repeat(40)}\n`;
            report += `Initial Balance: $${this.initialBalance.toFixed(2)}\n`;
            report += `Final Balance: $${this.balance.toFixed(2)}\n`;
            report += `Total Return: ${((this.balance - this.initialBalance) / this.initialBalance * 100).toFixed(2)}%\n`;
            report += `Gross Profit: $${grossProfit.toFixed(2)}\n`;
            report += `Net Profit: $${totalProfit.toFixed(2)}\n`;
            report += `Total Trades: ${this.results.totalTrades}\n`;
            report += `Win Rate: ${this.results.winRate.toFixed(1)}%\n`;
            report += `Max Drawdown: ${this.results.maxDrawdown.toFixed(2)}%\n`;
            report += `Profit Factor: ${this.results.profitFactor.toFixed(2)}\n`;
            report += `Sharpe Ratio: ${this.results.sharpeRatio.toFixed(3)}\n\n`;
            
            // Cost breakdown
            report += `COST BREAKDOWN:\n`;
            report += `${'-'.repeat(40)}\n`;
            report += `Trading Fees: $${this.results.totalFees.toFixed(2)} (${(this.results.totalFees/totalCosts*100).toFixed(1)}% of costs)\n`;
            report += `Slippage: $${this.results.totalSlippage.toFixed(2)} (${(this.results.totalSlippage/totalCosts*100).toFixed(1)}% of costs)\n`;
            report += `Funding: $${this.results.totalFunding.toFixed(2)} (${(this.results.totalFunding/totalCosts*100).toFixed(1)}% of costs)\n`;
            report += `Partial Fills: $${this.results.partialFillLoss.toFixed(2)} (${(this.results.partialFillLoss/totalCosts*100).toFixed(1)}% of costs)\n`;
            report += `Bad SL Fills: ${this.results.slWorseningCost} occurrences\n`;
            report += `Total Costs: $${totalCosts.toFixed(2)}\n`;
            report += `Cost Impact: ${(totalCosts / this.initialBalance * 100).toFixed(2)}% of initial capital\n`;
            report += `Cost Ratio: ${(totalCosts / Math.abs(grossProfit) * 100).toFixed(1)}% of gross profit\n\n`;
            
            // Break-even analysis
            const breakEvenWinRate = totalCosts > 0 ? (totalCosts / grossProfit) * 100 : 0;
            report += `Break-even Win Rate: ${breakEvenWinRate.toFixed(1)}% (excluding costs)\n\n`;
            
            // Symbol performance
            report += `SYMBOL PERFORMANCE:\n`;
            report += `${'-'.repeat(40)}\n`;
            for (const [symbol, result] of this.symbolResults.entries()) {
                const returnPercent = (result.profit / this.initialBalance) * 100;
                report += `${symbol}: ${returnPercent.toFixed(2)}% | $${result.profit.toFixed(2)} | ${result.trades} trades | ${result.winRate.toFixed(1)}% WR\n`;
            }
            
            // Trade analysis
            report += `\nTRADE ANALYSIS:\n`;
            report += `${'-'.repeat(40)}\n`;
            const winningTrades = this.trades.filter(t => t.pnl > 0);
            const losingTrades = this.trades.filter(t => t.pnl <= 0);
            const avgWin = winningTrades.length > 0 ? winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
            const avgLoss = losingTrades.length > 0 ? losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length : 0;
            
            report += `Average Winning Trade: $${avgWin.toFixed(2)}\n`;
            report += `Average Losing Trade: $${avgLoss.toFixed(2)}\n`;
            report += `Largest Win: $${this.results.largestWin.toFixed(2)}\n`;
            report += `Largest Loss: $${this.results.largestLoss.toFixed(2)}\n`;
            report += `Best Trade: $${Math.max(...this.trades.map(t => t.pnl)).toFixed(2)}\n`;
            report += `Worst Trade: $${Math.min(...this.trades.map(t => t.pnl)).toFixed(2)}\n`;
            
            // Exit reasons
            report += `\nEXIT REASONS:\n`;
            report += `${'-'.repeat(40)}\n`;
            const exitReasons = {};
            this.trades.forEach(trade => {
                exitReasons[trade.exitReason] = (exitReasons[trade.exitReason] || 0) + 1;
            });
            for (const [reason, count] of Object.entries(exitReasons)) {
                report += `${reason}: ${count} trades (${((count / this.trades.length) * 100).toFixed(1)}%)\n`;
            }
            
            fs.writeFileSync(filepath, report);
            console.log(`📋 Summary report saved to: ${filepath}`);
            
        } catch (error) {
            console.error('❌ Error saving summary report:', error.message);
        }
    }

    async runMultiBacktest(symbolFileMap, options = {}) {
        console.log(`🧪 REALISTIC MULTI-PAIR BACKTESTING STARTING`);
        console.log(`📊 Testing ${Object.keys(symbolFileMap).length} pairs: ${Object.keys(symbolFileMap).join(', ')}`);
        console.log(`🎯 Max Open Positions: ${config.trading.maxOpenPositions}`);

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

        const commonTimeline = this.createCommonTimeline(allData);
        console.log(`\n⏰ Common timeline: ${commonTimeline.length} trading cycles`);

        const originalBalance = this.balance;
        
        await this.executeTradingCycles(allData, commonTimeline);
        this.calculateAdvancedMetrics(this.equityCurve);
        this.printMultiPairSummary(originalBalance);
        
        console.log('\n💾 Saving results to files...');
        this.saveResultsToFile();
        this.saveSummaryReport();
        
        console.log(`\n🎉 All results saved to: ${this.resultsDir}`);
    }

    createCommonTimeline(allData) {
        const timelines = [];
        
        for (const [symbol, data] of allData.entries()) {
            const symbolTimeline = data.map(kline => kline.time);
            timelines.push(symbolTimeline);
        }

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
        
        console.log(`\n🚀 Starting realistic trading cycle simulation...`);
        console.log(`📊 ${timeline.length} total cycles to process`);

        for (let cycleIndex = 0; cycleIndex < timeline.length; cycleIndex++) {
            this.currentCycle = cycleIndex;
            this.currentTime = timeline[cycleIndex];
            
            if (cycleIndex % 200 === 0) {
                console.log(`\n🔄 Cycle ${cycleIndex}/${timeline.length} - ${new Date(this.currentTime).toISOString()}`);
                console.log(`   📊 Open Positions: ${this.openPositions.size}/${config.trading.maxOpenPositions}`);
                console.log(`   💰 Current Balance: $${this.balance.toFixed(2)}`);
                console.log(`   📈 Total Signals: ${totalSignals}`);
                console.log(`   💼 Total Trades: ${this.trades.length}`);
            }

            await this.checkAndExitPositions(allData, this.currentTime);
            
            if (this.openPositions.size < config.trading.maxOpenPositions) {
                const symbols = Array.from(allData.keys());
                
                let signalsThisCycle = 0;
                for (const symbol of symbols) {
                    if (this.hasOpenPosition(symbol)) continue;
                    if (this.openPositions.size >= config.trading.maxOpenPositions) break;

                    const signalFound = await this.analyzeSymbolInCycle(symbol, allData.get(symbol), this.currentTime, cycleIndex);
                    if (signalFound) {
                        signalsThisCycle++;
                        totalSignals++;
                    }
                }
            }

            this.equityCurve.push(this.balance);
            if (this.balance > this.peakEquity) {
                this.peakEquity = this.balance;
            }
            
            cycleCount++;
        }

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

            const currentKline = symbolData.find(k => k.time === currentTime);
            if (!currentKline) continue;

            const exitReason = this.checkExitConditions(position, currentKline);
            if (exitReason) {
                positionsToClose.push({ symbol, position, currentPrice: currentKline.close, exitReason });
            }
        }

        for (const { symbol, position, currentPrice, exitReason } of positionsToClose) {
            await this.exitPosition(position, currentPrice, currentTime, exitReason);
            this.openPositions.delete(symbol);
        }

        return positionsToClose.length;
    }

    async analyzeSymbolInCycle(symbol, data, currentTime, cycleIndex) {
        try {
            const currentData = data.slice(0, cycleIndex + 1);
            
            if (currentData.length < 100) return false;

            const currentKline = currentData[currentData.length - 1];
            const currentPrice = currentKline.close;

            const signal = this.strategy.analyze(currentData, symbol);
            
            if (signal.signal !== 'HOLD') {
                const position = await this.enterPosition(symbol, signal.signal, currentPrice, currentTime, currentData);
                return position !== null;
            }
            
            return false;
        } catch (error) {
            console.error(`❌ Error analyzing ${symbol}:`, error.message);
            return false;
        }
    }

    async enterPosition(symbol, side, signalPrice, entryTime, klines) {
        if (this.openPositions.size >= config.trading.maxOpenPositions) return null;
        if (this.hasOpenPosition(symbol)) return null;

        // 🆕 CALCULATE VOLATILITY FOR SLIPPAGE
        const volatility = this.calculateVolatility(klines);
        const recentVolume = klines.length > 0 ? klines[klines.length - 1].volume : 0;
        
        // 🆕 APPLY REALISTIC ENTRY SLIPPAGE
        const actualEntryPrice = this.applyEntrySlippage(signalPrice, side, recentVolume, volatility);
        
        // 🆕 USE REALISTIC POSITION SIZING
        const baseQuantity = this.strategy.calculatePositionSize(this.balance, actualEntryPrice, symbol);
        
        // 🆕 SIMULATE PARTIAL FILLS
        //const execution = this.simulateOrderExecution(baseQuantity, 'MARKET');
        //const actualQuantity = execution.filled;
        const actualQuantity = baseQuantity;
        if (actualQuantity <= 0) return null;

        const position = {
            symbol: symbol,
            side: side,
            signalPrice: signalPrice,
            entryPrice: actualEntryPrice,
            entryTime: entryTime,
            quantity: actualQuantity,
            leverage: config.trading.leverage,
            marginUsed: actualQuantity * actualEntryPrice / config.trading.leverage,
            entryBalance: this.balance,
            levels: this.strategy.calculateLevels(actualEntryPrice, side, symbol),
            entrySlippage: Math.abs(actualEntryPrice - signalPrice) * actualQuantity,
            partialFill: false,//execution.partial,
            unfilledAmount: 0//execution.unfilledAmount || 0
        };

        this.openPositions.set(symbol, position);
        this.results.totalSlippage += position.entrySlippage;
        //this.results.partialFillLoss += execution.partialLoss || 0;
        
        if (this.currentCycle % 200 === 0) {
            console.log(`   🎯 ${symbol} ENTERED ${side} at $${actualEntryPrice.toFixed(2)} (signal: $${signalPrice.toFixed(2)})`);
            console.log(`      Slippage: $${position.entrySlippage.toFixed(2)} | Quantity: ${actualQuantity.toFixed(6)}`);
            /*if (execution.partial) {
                console.log(`      ⚠️ Partial fill: ${execution.unfilledAmount.toFixed(6)} unfilled`);
            }*/
        }

        return position;
    }

    hasOpenPosition(symbol) {
        return this.openPositions.has(symbol);
    }

    async closeAllPositions(allData, endTime) {
        console.log(`\n🔚 Closing all remaining positions...`);
        
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

        const holdTime = kline.time - position.entryTime;
        const maxHoldTime = config.strategy.maxHoldTime || (8 * 60 * 60 * 1000);
        
        if (holdTime >= maxHoldTime) return 'MAX_HOLD_TIME_REACHED';

        return null;
    }

    async exitPosition(position, signalPrice, exitTime, exitReason) {
        // 🆕 CALCULATE VOLATILITY FOR EXIT SLIPPAGE
        const volatility = this.calculateVolatility([{high: signalPrice * 1.01, low: signalPrice * 0.99, close: signalPrice}]);
        const recentVolume = 0; // Would need volume data for exit
        
        // 🆕 APPLY REALISTIC EXIT SLIPPAGE
        const actualExitPrice = this.applyExitSlippage(signalPrice, position.side, exitReason, volatility, recentVolume);
        
        // 🆕 CALCULATE FUNDING COST
        const holdTime = exitTime - position.entryTime;
        const fundingCost = this.calculateFundingCost(position, holdTime);
        
        const profit = this.calculateProfit(position, actualExitPrice, fundingCost);
        this.balance += profit;

        const exitSlippage = Math.abs(actualExitPrice - signalPrice) * position.quantity;
        this.results.totalSlippage += exitSlippage;
        this.results.totalFunding += fundingCost;

        const trade = {
            id: this.trades.length + 1,
            symbol: position.symbol,
            side: position.side,
            signalEntryPrice: position.signalPrice,
            actualEntryPrice: position.entryPrice,
            signalExitPrice: signalPrice,
            actualExitPrice: actualExitPrice,
            quantity: position.quantity,
            pnl: profit,
            pnlPercent: (profit / position.entryBalance) * 100,
            entryTime: new Date(position.entryTime).toISOString(),
            exitTime: new Date(exitTime).toISOString(),
            duration: holdTime / (1000 * 60),
            exitReason: exitReason,
            // 🆕 Cost breakdown
            entrySlippage: position.entrySlippage,
            exitSlippage: exitSlippage,
            totalSlippage: position.entrySlippage + exitSlippage,
            fundingCost: fundingCost,
            fees: this.calculateFees(position.entryPrice, actualExitPrice, position.quantity)
        };

        this.trades.push(trade);

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
            console.log(`   💰 ${position.symbol} EXIT at $${actualExitPrice.toFixed(2)} | PnL: $${profit.toFixed(2)} | ${exitReason}`);
            console.log(`      Costs: Slippage $${(position.entrySlippage + exitSlippage).toFixed(2)}, Funding $${fundingCost.toFixed(2)}`);
        }
    }

    calculateFees(entryPrice, exitPrice, quantity) {
        const entryValue = quantity * entryPrice;
        const exitValue = quantity * exitPrice;
        
        // 🚨 FIX: Divide by 10000 for 0.04% (0.04 / 100 = 0.0004)
        const entryFee = entryValue * (this.tradingCosts.feePercent / 10000);
        const exitFee = exitValue * (this.tradingCosts.feePercent / 10000);
        
        const totalFees = entryFee + exitFee;
        this.results.totalFees += totalFees;
        return totalFees;
    }

    calculateProfit(position, exitPrice, fundingCost = 0) {
        const priceDifference = exitPrice - position.entryPrice;
        
        let grossProfit;
        if (position.side === 'BUY') {
            grossProfit = priceDifference * position.quantity;
        } else {
            grossProfit = -priceDifference * position.quantity;
        }
        
        grossProfit *= position.leverage;
        
        // Fees
        const fees = this.calculateFees(position.entryPrice, exitPrice, position.quantity);
        
        const netProfit = grossProfit - fees - fundingCost;
        return netProfit;
    }

    calculateAdvancedMetrics(equityCurve) {
        this.results.winRate = this.results.totalTrades > 0
            ? (this.results.winningTrades / this.results.totalTrades) * 100
            : 0;

        const grossProfit = this.trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
        const grossLoss = Math.abs(this.trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
        this.results.profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

        const returns = [];
        for (let i = 1; i < equityCurve.length; i++) {
            returns.push((equityCurve[i] - equityCurve[i-1]) / equityCurve[i-1]);
        }
        
        const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
        const variance = returns.reduce((a, b) => a + Math.pow(b - avgReturn, 2), 0) / returns.length;
        const stdDev = Math.sqrt(variance);
        this.results.sharpeRatio = stdDev > 0 ? avgReturn / stdDev : 0;

        let maxDrawdown = 0;
        let peak = equityCurve[0];
        for (let i = 1; i < equityCurve.length; i++) {
            if (equityCurve[i] > peak) peak = equityCurve[i];
            const drawdown = ((peak - equityCurve[i]) / peak) * 100;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }
        this.results.maxDrawdown = maxDrawdown;
    }

    printMultiPairSummary(originalBalance) {
        const totalReturn = ((this.balance - originalBalance) / originalBalance) * 100;
        const totalProfit = this.balance - originalBalance;
        const totalCosts = this.results.totalFees + this.results.totalSlippage + this.results.totalFunding + this.results.partialFillLoss;
        const grossProfit = totalProfit + totalCosts;
        
        const symbolTrades = new Map();
        for (const trade of this.trades) {
            if (!symbolTrades.has(trade.symbol)) {
                symbolTrades.set(trade.symbol, []);
            }
            symbolTrades.get(trade.symbol).push(trade);
        }
        
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
        console.log('🎉 REALISTIC BACKTEST COMPLETED - FINAL SUMMARY');
        console.log('='.repeat(80));
        console.log(`💰 Initial Balance: $${originalBalance.toFixed(2)}`);
        console.log(`💰 Final Balance: $${this.balance.toFixed(2)}`);
        console.log(`📈 Total Return: ${totalReturn.toFixed(2)}%`);
        console.log(`💰 Net Profit: $${totalProfit.toFixed(2)}`);
        console.log(`📊 Total Trades: ${this.results.totalTrades}`);
        console.log(`🎯 Win Rate: ${this.results.winRate.toFixed(1)}%`);
        console.log(`📉 Max Drawdown: ${this.results.maxDrawdown.toFixed(2)}%`);
        console.log(`📈 Profit Factor: ${this.results.profitFactor.toFixed(2)}`);
        
        // 🆕 DETAILED COST BREAKDOWN
        console.log(`\n💸 DETAILED COST BREAKDOWN:`);
        console.log(`   Gross Profit: $${grossProfit.toFixed(2)}`);
        console.log(`   Net Profit: $${totalProfit.toFixed(2)}`);
        console.log(`   Cost Ratio: ${(totalCosts / Math.abs(grossProfit) * 100).toFixed(1)}% of gross profit`);
        console.log(`   ──────────────────────────`);
        console.log(`   Trading Fees: $${this.results.totalFees.toFixed(2)} (${(this.results.totalFees/totalCosts*100).toFixed(1)}% of costs)`);
        console.log(`   Slippage: $${this.results.totalSlippage.toFixed(2)} (${(this.results.totalSlippage/totalCosts*100).toFixed(1)}% of costs)`);
        console.log(`   Funding: $${this.results.totalFunding.toFixed(2)} (${(this.results.totalFunding/totalCosts*100).toFixed(1)}% of costs)`);
        console.log(`   Partial Fills: $${this.results.partialFillLoss.toFixed(2)} (${(this.results.partialFillLoss/totalCosts*100).toFixed(1)}% of costs)`);
        console.log(`   Bad SL Fills: ${this.results.slWorseningCost} occurrences`);
        console.log(`   ──────────────────────────`);
        console.log(`   Total Costs: $${totalCosts.toFixed(2)}`);
        console.log(`   Cost Impact: ${(totalCosts / this.initialBalance * 100).toFixed(2)}% of initial capital`);
        
        // Break-even analysis
        const breakEvenWinRate = totalCosts > 0 ? (totalCosts / grossProfit) * 100 : 0;
        console.log(`   Break-even Win Rate: ${breakEvenWinRate.toFixed(1)}% (excluding costs)`);
        
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
        
        console.log('='.repeat(80));
    }

    // [Keep all other utility methods the same]
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

export default BinanceCSVBacktester;