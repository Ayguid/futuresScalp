import fs from 'fs';
import path from 'path';

class Logger {
    constructor() {
        this.logDir = './logs';
        this.ensureLogDirectory();
        
        this.errorLog = path.join(this.logDir, 'errors.log');
        this.positionsLog = path.join(this.logDir, 'positions.log');
        this.tradesLog = path.join(this.logDir, 'trades.log');
        // 🚫 REMOVED: this.signalsLog
    }

    ensureLogDirectory() {
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    formatTimestamp() {
        return new Date().toISOString();
    }

    writeToFile(file, message) {
        try {
            const timestamp = this.formatTimestamp();
            const logMessage = `[${timestamp}] ${message}\n`;
            fs.appendFileSync(file, logMessage, 'utf8');
        } catch (error) {
            console.error('❌ Failed to write to log file:', error.message);
        }
    }

    // ✅ SIMPLIFIED - no signal data parameter needed anymore
    position(message) {
        const fullMessage = `📊 ${message}`;
        console.log(fullMessage);
        this.writeToFile(this.positionsLog, fullMessage);
    }

    error(message, context = '') {
        const fullMessage = context ? `❌ ${context}: ${message}` : `❌ ${message}`;
        console.error(fullMessage);
        this.writeToFile(this.errorLog, fullMessage);
    }

    trade(message) {
        const fullMessage = `🎯 ${message}`;
        console.log(fullMessage);
        this.writeToFile(this.tradesLog, fullMessage);
    }

    info(message) {
        const fullMessage = `ℹ️ ${message}`;
        console.log(fullMessage);
    }

    debug(message) {
        const fullMessage = `🔍 ${message}`;
        console.log(fullMessage);
    }

    // ✅ UPDATED - removed signals from fileMap
    readLog(fileType) {
        try {
            const fileMap = {
                'errors': this.errorLog,
                'positions': this.positionsLog,
                'trades': this.tradesLog
                // 🚫 REMOVED: 'signals'
            };
            
            const filePath = fileMap[fileType];
            if (filePath && fs.existsSync(filePath)) {
                return fs.readFileSync(filePath, 'utf8');
            }
            return `No ${fileType} log found`;
        } catch (error) {
            return `Error reading ${fileType} log: ${error.message}`;
        }
    }

    // ✅ UPDATED - removed signals from fileMap
    clearLog(fileType) {
        try {
            const fileMap = {
                'errors': this.errorLog,
                'positions': this.positionsLog,
                'trades': this.tradesLog
                // 🚫 REMOVED: 'signals'
            };
            
            const filePath = fileMap[fileType];
            if (filePath) {
                fs.writeFileSync(filePath, '');
                console.log(`✅ Cleared ${fileType} log`);
            }
        } catch (error) {
            console.error(`❌ Error clearing ${fileType} log:`, error.message);
        }
    }
}

export default Logger;