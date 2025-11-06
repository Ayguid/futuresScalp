import ScalpingBot from '#bot/ScalpingBot';

const bot = new ScalpingBot();

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, async () => {
        console.log(`\n🛑 Received ${signal}...`);
        await bot.stop();
        process.exit(0);
    });
});

// Start bot
bot.start().catch(console.error);