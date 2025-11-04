const crypto = require('crypto-js');
const axios = require('axios');
const config = require('./config');

class BinanceClient {
    constructor() {
        this.config = config.getCurrentConfig();
        this.baseURL = this.config.baseURL;
        this.exchangeInfo = null;
        this.symbolInfoCache = {};
    }

    generateSignature(queryString) {
        return crypto.HmacSHA256(queryString, this.config.secretKey).toString(crypto.enc.Hex);
    }

    getTimestamp() {
        return Date.now().toString();
    }

    async makeRequest(method, endpoint, params = {}) {
        const timestamp = this.getTimestamp();
        const queryParams = new URLSearchParams({
            ...params,
            timestamp: timestamp,
            recvWindow: 60000
        });

        const signature = this.generateSignature(queryParams.toString());
        queryParams.append('signature', signature);

        const url = `${this.baseURL}${endpoint}?${queryParams.toString()}`;

        try {
            const response = await axios({
                method: method,
                url: url,
                headers: {
                    'X-MBX-APIKEY': this.config.apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });
            return response.data;
        } catch (error) {
            throw error.response ? error.response.data : error;
        }
    }

    async getExchangeInfo() {
        if (!this.exchangeInfo) {
            const response = await axios.get(`${this.baseURL}/fapi/v1/exchangeInfo`);
            this.exchangeInfo = response.data;
        }
        return this.exchangeInfo;
    }

    async getSymbolInfo(symbol) {
        if (this.symbolInfoCache[symbol]) {
            return this.symbolInfoCache[symbol];
        }

        const exchangeInfo = await this.getExchangeInfo();
        const symbolData = exchangeInfo.symbols.find(s => s.symbol === symbol);

        if (!symbolData) throw new Error(`Symbol ${symbol} not found`);

        const filters = {};
        symbolData.filters.forEach(filter => {
            filters[filter.filterType] = filter;
        });

        const info = {
            symbol: symbolData.symbol,
            status: symbolData.status,
            baseAsset: symbolData.baseAsset,
            quoteAsset: symbolData.quoteAsset,
            pricePrecision: symbolData.pricePrecision,
            quantityPrecision: symbolData.quantityPrecision,
            filters: filters
        };

        this.symbolInfoCache[symbol] = info;
        return info;
    }

    // Price adjustment for tick size
    adjustPriceToTickSize(price, tickSize) {
        const precision = Math.max(0, Math.ceil(-Math.log10(tickSize)));
        const adjusted = Math.floor(price / tickSize) * tickSize;
        return parseFloat(adjusted.toFixed(precision));
    }

    // Quantity adjustment for step size
    // In binanceClient.js - FIXED VERSION
    adjustQuantityToStepSize(quantity, stepSize) {
        // For step sizes >= 1 (like ADAUSDT with stepSize = 1)
        if (stepSize >= 1) {
            return Math.floor(quantity / stepSize) * stepSize;
        }

        // For step sizes < 1 (like BTCUSDT with stepSize = 0.001)
        // Use Math.ceil instead of Math.floor to ensure we don't round down to 0
        const precision = Math.max(0, Math.ceil(-Math.log10(stepSize)));
        const adjusted = Math.ceil(quantity / stepSize) * stepSize; // CHANGED TO Math.ceil
        return parseFloat(adjusted.toFixed(precision));
    }

    // Calculate proper quantity for minimum notional
    // In binanceClient.js - improve quantity calculation
    // In binanceClient.js - IMPROVED VERSION
    async calculateProperQuantity(symbol, price, minNotionalMultiplier = 1.1) {
        const symbolInfo = await this.getSymbolInfo(symbol);
        const minNotional = parseFloat(symbolInfo.filters.MIN_NOTIONAL.notional);
        const stepSize = parseFloat(symbolInfo.filters.LOT_SIZE.stepSize);
        const minQty = parseFloat(symbolInfo.filters.LOT_SIZE.minQty);

        // Calculate minimum quantity needed
        const requiredNotional = minNotional * minNotionalMultiplier;
        let quantity = requiredNotional / price;

        // Ensure we meet minimum quantity
        quantity = Math.max(quantity, minQty);

        // Adjust to step size - use ceil to ensure we meet minimum
        quantity = Math.ceil(quantity / stepSize) * stepSize;

        // Final verification
        const finalNotional = quantity * price;
        if (finalNotional < minNotional) {
            // If still too small, increase by one step
            quantity += stepSize;
        }

        return quantity;
    }

    // Trading methods
    async placeMarketOrder(symbol, side, quantity) {
        const order = {
            symbol: symbol,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity: quantity.toString()
        };
        return await this.makeRequest('POST', '/fapi/v1/order', order);
    }

    async placeLimitOrder(symbol, side, quantity, price) {
        const symbolInfo = await this.getSymbolInfo(symbol);
        const adjustedPrice = this.adjustPriceToTickSize(price, parseFloat(symbolInfo.filters.PRICE_FILTER.tickSize));

        const order = {
            symbol: symbol,
            side: side.toUpperCase(),
            type: 'LIMIT',
            quantity: quantity.toString(),
            price: adjustedPrice.toString(),
            timeInForce: 'GTC'
        };
        return await this.makeRequest('POST', '/fapi/v1/order', order);
    }

    async cancelOrder(symbol, orderId) {
        return await this.makeRequest('DELETE', '/fapi/v1/order', {
            symbol: symbol,
            orderId: orderId
        });
    }

    async getAccountInfo() {
        return await this.makeRequest('GET', '/fapi/v2/account');
    }

    async getOpenPositions() {
        const positions = await this.makeRequest('GET', '/fapi/v2/positionRisk');
        return positions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
    }

    async getOpenOrders(symbol = null) {
        const params = symbol ? { symbol } : {};
        return await this.makeRequest('GET', '/fapi/v1/openOrders', params);
    }

async setLeverage(symbol, leverage) {
    try {
        console.log(`⚙️ Setting ${symbol} leverage to ${leverage}x...`);
        
        const params = {
            symbol: symbol,
            leverage: leverage
        };

        console.log(`📡 Making leverage API call for ${symbol}...`);
        const result = await this.makeRequest('POST', '/fapi/v1/leverage', params);
        
        console.log(`✅ ${symbol} leverage set to: ${leverage}x`);
        return result;
    } catch (error) {
        console.log(`🔍 Leverage error details for ${symbol}:`);
        console.log(`   Error code: ${error.code}`);
        console.log(`   Error message: ${error.msg || error.message}`);
        
        if (error.code === -4046 || error.msg?.includes('leverage not modified')) {
            console.log(`ℹ️ ${symbol} leverage already set to: ${leverage}x`);
            return { alreadySet: true };
        } else {
            console.error(`❌ Error setting leverage for ${symbol}:`, error.msg || error.message);
            throw error;
        }
    }
}

    // Market data methods
    async getPrice(symbol) {
        const response = await axios.get(`${this.baseURL}/fapi/v1/ticker/price?symbol=${symbol}`);
        return parseFloat(response.data.price);
    }


async setMarginMode(symbol, marginType = 'ISOLATED') {
    try {
        console.log(`⚙️ Setting ${symbol} margin mode to ${marginType}...`);
        
        const params = {
            symbol: symbol,
            marginType: marginType.toUpperCase()
        };

        console.log(`📡 Making margin mode API call for ${symbol}...`);
        const result = await this.makeRequest('POST', '/fapi/v1/marginType', params);
        
        console.log(`✅ ${symbol} margin mode set to: ${marginType}`);
        return result;
    } catch (error) {
        console.log(`🔍 Margin mode error details for ${symbol}:`);
        console.log(`   Error code: ${error.code}`);
        console.log(`   Error message: ${error.msg || error.message}`);
        
        // If margin mode is already set, Binance returns error code -4046
        if (error.code === -4046 || error.msg?.includes('No need to change margin type')) {
            console.log(`ℹ️ ${symbol} margin mode already set to: ${marginType}`);
            return { alreadySet: true };
        } else {
            console.error(`❌ Error setting margin mode for ${symbol}:`, error.msg || error.message);
            throw error;
        }
    }
}

    async getKlines(symbol, interval = '1m', limit = 100) {
        const response = await axios.get(`${this.baseURL}/fapi/v1/klines`, {
            params: { symbol, interval, limit }
        });
        return response.data.map(k => ({
            time: parseFloat(k[0]),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5])
        }));
    }

    // 🆕 ADD TO binanceClient.js - Stop Market Order
    async placeStopMarketOrder(symbol, side, quantity, stopPrice) {
        const symbolInfo = await this.getSymbolInfo(symbol);
        const adjustedStopPrice = this.adjustPriceToTickSize(stopPrice, parseFloat(symbolInfo.filters.PRICE_FILTER.tickSize));

        const order = {
            symbol: symbol,
            side: side.toUpperCase(),
            type: 'STOP_MARKET',
            quantity: quantity.toString(),
            stopPrice: adjustedStopPrice.toString(),
            timeInForce: 'GTC'
        };
        return await this.makeRequest('POST', '/fapi/v1/order', order);
    }
}

module.exports = BinanceClient;