const ScalpingBot = require('./scalpingBot');

// Create and start the bot
const bot = new ScalpingBot();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Received shutdown signal...');
    bot.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received termination signal...');
    bot.stop();
    process.exit(0);
});

// Start the bot
bot.start().catch(console.error);

// Export for testing
module.exports = bot;