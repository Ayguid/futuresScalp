const BinanceCSVBacktester = require('./backtester');
const fs = require('fs');
const path = require('path');

async function main() {
    const backtester = new BinanceCSVBacktester();
    
    // File is in the same 'data' folder within backtesting
    const csvFilePath = path.join(__dirname, 'data/BTCUSDT-15m-2025-10.csv');
    
    // Check if file exists first
    if (!fs.existsSync(csvFilePath)) {
        console.log('❌ CSV file not found:', csvFilePath);
        console.log('\n📥 Please download the data first:');
        //console.log('https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/15m/BTCUSDT-5m-2025-10.zip');
        console.log('\n💡 Extract the CSV file to:', path.resolve(csvFilePath));
        console.log('\n📁 Current working directory:', __dirname);
        
        // Show what files are available
        const dataDir = path.join(__dirname, 'data');
        if (fs.existsSync(dataDir)) {
            const files = fs.readdirSync(dataDir);
            console.log('\n📋 Available files in data folder:');
            files.forEach(file => console.log('   -', file));
        }
        return;
    }

    // Check file size
    const stats = fs.statSync(csvFilePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    console.log(`📁 File size: ${fileSizeMB.toFixed(2)} MB`);

    if (fileSizeMB < 0.1) {
        console.log('⚠️  File seems very small - might be empty or incomplete');
    }

    console.log('🧪 Starting Backtest: Advanced Scalping Strategy');
    console.log('📅 Period: October 2025');
    console.log('⏰ Timeframe: 1m (resampled to strategy timeframe)');
    console.log('==================================================\n');

    try {
        await backtester.runBacktest('BTCUSDT', csvFilePath);
        
        console.log('\n🎉 Backtest completed successfully!');
        console.log('💡 Check the backtesting/results/ folder for detailed reports');
        
    } catch (error) {
        console.error('❌ Backtest failed:', error.message);
        
        if (error.message.includes('ENOENT') || error.message.includes('file')) {
            console.log('\n💡 Solution: Download the data from:');
            console.log('https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/5m/');
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