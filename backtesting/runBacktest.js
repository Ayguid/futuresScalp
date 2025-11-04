import { fileURLToPath } from 'url';
import { dirname } from 'path';
import BinanceCSVBacktester from './backtester.js';
import fs from 'fs';
import path from 'path';
import config from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
    const backtester = new BinanceCSVBacktester();
    
    // 🆕 GET SYMBOLS FROM CONFIG
    const symbols = config.trading.symbols || ['BTCUSDT'];
    
    // 🆕 AUTO-GENERATE FILE PATHS BASED ON CONFIG SYMBOLS
    const symbolFileMap = {};
    const availablePairs = [];

    console.log('🔍 Looking for data files...');
    console.log(`📊 Symbols from config: ${symbols.join(', ')}`);
    
    for (const symbol of symbols) {
        const timeframe = config.strategy.timeframe;
        const csvFilePath = path.join(__dirname, 'data', `${symbol}-${timeframe}-2025-10.csv`);
        
        if (fs.existsSync(csvFilePath)) {
            symbolFileMap[symbol] = csvFilePath;
            availablePairs.push(symbol);
            console.log(`✅ Found data for: ${symbol}`);
        } else {
            console.log(`❌ Missing data for: ${symbol} (looking for: ${path.basename(csvFilePath)})`);
        }
    }

    if (availablePairs.length === 0) {
        console.log('\n❌ No data files found!');
        console.log('📥 Please download data files to the data/ folder');
        console.log(`💡 Format: SYMBOL-${config.strategy.timeframe}-2025-10.csv`);
        
        const dataDir = path.join(__dirname, 'data');
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir);
            console.log('\n📋 Available files in data folder:');
            files.forEach(file => console.log('   -', file));
        }
        return;
    }

    console.log(`\n🧪 Testing ${availablePairs.length} pairs: ${availablePairs.join(', ')}`);
    console.log('==================================================');
    console.log(`💰 Initial Balance: $${backtester.initialBalance}`);
    console.log(`🎯 Max Open Positions: ${config.trading.maxOpenPositions}`);
    console.log(`⏰ Timeframe: ${config.strategy.timeframe}`);
    console.log(`⚡ Leverage: ${config.trading.leverage}x`);
    console.log('==================================================\n');

    try {
        // 🆕 USE MULTI-PAIR BACKTEST
        await backtester.runMultiBacktest(symbolFileMap);
        console.log('\n🎉 Multi-pair backtest completed!');
        console.log('💡 Check the backtesting/results/ folder for detailed reports');
        
    } catch (error) {
        console.error('❌ Backtest failed:', error.message);
        
        if (error.message.includes('ENOENT') || error.message.includes('file')) {
            console.log('\n💡 Solution: Download the data from:');
            console.log('https://data.binance.vision/data/futures/um/monthly/klines/');
        }
    }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('💥 Uncaught Exception:', error.message);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

main().catch(console.error);