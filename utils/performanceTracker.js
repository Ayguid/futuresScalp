import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PerformanceTracker {
    constructor() {
        this.trades = [];
        this.filePath = path.join(__dirname, '../data/trade_history.json');

        // Load past trades if the file exists
        this.loadFromFile();
    }

    loadFromFile() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                this.trades = JSON.parse(raw);
                console.log(`📂 Loaded ${this.trades.length} past trades from trade_history.json`);
            }
        } catch (error) {
            console.error('❌ Failed to load trade history:', error.message);
        }
    }

    saveToFile() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            fs.writeFileSync(this.filePath, JSON.stringify(this.trades, null, 2));
        } catch (error) {
            console.error('❌ Failed to save trade history:', error.message);
        }
    }

    recordTrade(symbol, side, entryPrice, exitPrice, qty) {
        const pnl = side === 'BUY'
            ? (exitPrice - entryPrice) * qty
            : (entryPrice - exitPrice) * qty;

        const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * (side === 'BUY' ? 1 : -1) * 100;

        const trade = {
            timestamp: new Date().toISOString(),
            symbol,
            side,
            entryPrice,
            exitPrice,
            qty,
            pnl: +pnl.toFixed(2),
            pnlPercent: +pnlPercent.toFixed(2)
        };

        this.trades.push(trade);
        this.saveToFile(); // 💾 Save after each trade
        this.printSummary(trade);
    }

    printSummary(trade) {
        console.log(
            `📊 Trade Summary | ${trade.symbol} | ${trade.side} | Entry: ${trade.entryPrice.toFixed(2)} | Exit: ${trade.exitPrice.toFixed(2)} | PnL: ${trade.pnl} USDT (${trade.pnlPercent}%)`
        );
    }

    getStats() {
        if (this.trades.length === 0) {
            return {
                totalTrades: 0,
                totalPnL: 0,
                avgPnL: 0,
                winRate: '0%'
            };
        }

        const totalPnL = this.trades.reduce((sum, t) => sum + t.pnl, 0);
        const avgPnL = totalPnL / this.trades.length;
        const winRate = (this.trades.filter(t => t.pnl > 0).length / this.trades.length) * 100;

        return {
            totalTrades: this.trades.length,
            totalPnL: totalPnL.toFixed(2),
            avgPnL: avgPnL.toFixed(2),
            winRate: winRate.toFixed(2) + '%'
        };
    }

    exportToCSV() {
        const csvFile = path.join(__dirname, '../data/trade_history.csv');
        const headers = 'timestamp,symbol,side,entryPrice,exitPrice,qty,pnl,pnlPercent\n';
        const rows = this.trades.map(t =>
            `${t.timestamp},${t.symbol},${t.side},${t.entryPrice},${t.exitPrice},${t.qty},${t.pnl},${t.pnlPercent}`
        );
        fs.writeFileSync(csvFile, headers + rows.join('\n'));
        console.log(`💾 Trades exported to ${csvFile}`);
    }
}

export default new PerformanceTracker();
