import crypto from 'crypto';
import axios from 'axios';
import config from '#config';
import RateLimitedQueue from '#utils/RateLimitedQueue';
//https://developers.binance.com/docs/derivatives/usds-margined-futures
class BinanceClient {
    constructor() {
        this.config = config.getCurrentConfig();
        this.baseURL = this.config.baseURL;
        this.exchangeInfo = null;
        this.symbolInfoCache = {};
        
        this.rateLimiter = new RateLimitedQueue(1000, 100, 10);
    }

    // ✅ FIXED: Better error handling that preserves Binance error details
    async makeAxiosCall(config) {
        return new Promise((resolve, reject) => {
            const wrappedFn = async (done) => {
                try {
                    const response = await axios(config);
                    resolve(response.data);
                } catch (error) {
                    // ✅ PRESERVE BINANCE ERROR DETAILS
                    if (error.response && error.response.data) {
                        // Binance API error with detailed message
                        reject({
                            code: error.response.data.code,
                            msg: error.response.data.msg,
                            message: `Binance Error ${error.response.data.code}: ${error.response.data.msg}`,
                            originalError: error.response.data
                        });
                    } else if (error.request) {
                        // Network error
                        reject({
                            message: `Network Error: ${error.message || 'No response from Binance'}`,
                            originalError: error
                        });
                    } else {
                        // Other error
                        reject({
                            message: error.message,
                            originalError: error
                        });
                    }
                } finally {
                    done();
                }
            };
            
            this.rateLimiter.enqueue(wrappedFn);
        });
    }

    // Public requests - no authentication
    async publicRequest(method, endpoint, params = {}) {
        const config = {
            method,
            url: `${this.baseURL}${endpoint}`,
            params: params,
            timeout: 10000
        };
        
        return this.makeAxiosCall(config);
    }

    // Private requests - with authentication
    async privateRequest(method, endpoint, params = {}) {
        const timestamp = Date.now().toString();
        const queryParams = new URLSearchParams({
            ...params,
            timestamp,
            recvWindow: 60000
        });

        const signature = crypto
            .createHmac('sha256', this.config.secretKey)
            .update(queryParams.toString())
            .digest('hex');
        queryParams.append('signature', signature);

        const config = {
            method,
            url: `${this.baseURL}${endpoint}?${queryParams.toString()}`,
            headers: {
                'X-MBX-APIKEY': this.config.apiKey,
                'Content-Type': 'application/json'
            },
            timeout: 10000
        };

        return this.makeAxiosCall(config);
    }

    // Public endpoints
    async getExchangeInfo() {
        if (!this.exchangeInfo) {
            this.exchangeInfo = await this.publicRequest('GET', '/fapi/v1/exchangeInfo');
        }
        return this.exchangeInfo;
    }

    async getPrice(symbol) {
        const data = await this.publicRequest('GET', '/fapi/v1/ticker/price', { symbol });
        return parseFloat(data.price);
    }

    async getKlines(symbol, interval = '1m', limit = 100) {
        const data = await this.publicRequest('GET', '/fapi/v1/klines', { 
            symbol, 
            interval, 
            limit 
        });
        return data.map(k => ({
            time: parseFloat(k[0]),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5])
        }));
    }

    // Private endpoints
    async getAccountInfo() {
        return await this.privateRequest('GET', '/fapi/v2/account');
    }

    async getOpenPositions() {
        const positions = await this.privateRequest('GET', '/fapi/v2/positionRisk');
        return positions.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
    }

    async getOpenOrders(symbol = null) {
        const params = symbol ? { symbol } : {};
        return await this.privateRequest('GET', '/fapi/v1/openOrders', params);
    }

    async getAllOrders(symbol, limit = 50) {
        return await this.privateRequest('GET', '/fapi/v1/allOrders', {
            symbol: symbol,
            limit: limit
        });
    }

    async getOrder(symbol, orderId) {
        return await this.privateRequest('GET', '/fapi/v1/order', {
            symbol: symbol,
            orderId: orderId
        });
    }

    async placeMarketOrder(symbol, side, quantity) {
        const order = {
            symbol: symbol,
            side: side.toUpperCase(),
            type: 'MARKET',
            quantity: quantity.toString()
        };
        return await this.privateRequest('POST', '/fapi/v1/order', order);
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
        return await this.privateRequest('POST', '/fapi/v1/order', order);
    }

    async cancelOrder(symbol, orderId) {
        return await this.privateRequest('DELETE', '/fapi/v1/order', {
            symbol: symbol,
            orderId: orderId
        });
    }

    async setLeverage(symbol, leverage) {
        try {
            console.log(`⚙️ Setting ${symbol} leverage to ${leverage}x...`);

            const params = {
                symbol: symbol,
                leverage: leverage
            };

            console.log(`📡 Making leverage API call for ${symbol}...`);
            const result = await this.privateRequest('POST', '/fapi/v1/leverage', params);

            console.log(`✅ ${symbol} leverage set to: ${leverage}x`);
            return result;
        } catch (error) {
            // ✅ NOW PRESERVES DETAILED ERROR MESSAGES
            console.log(`🔍 Leverage error details for ${symbol}:`);
            console.log(`   Error code: ${error.code}`);
            console.log(`   Error message: ${error.msg || error.message}`);

            if (error.code === -4046 || error.msg?.includes('leverage not modified')) {
                console.log(`ℹ️ ${symbol} leverage already set to: ${leverage}x`);
                return { alreadySet: true };
            } else {
                console.error(`❌ Error setting leverage for ${symbol}:`, error.msg || error.message);
                throw error; // ✅ Now throws the detailed error object
            }
        }
    }

    async setMarginMode(symbol, marginType = 'ISOLATED') {
        try {
            console.log(`⚙️ Setting ${symbol} margin mode to ${marginType}...`);

            const params = {
                symbol: symbol,
                marginType: marginType.toUpperCase()
            };

            console.log(`📡 Making margin mode API call for ${symbol}...`);
            const result = await this.privateRequest('POST', '/fapi/v1/marginType', params);

            console.log(`✅ ${symbol} margin mode set to: ${marginType}`);
            return result;
        } catch (error) {
            // ✅ NOW PRESERVES DETAILED ERROR MESSAGES
            console.log(`🔍 Margin mode error details for ${symbol}:`);
            console.log(`   Error code: ${error.code}`);
            console.log(`   Error message: ${error.msg || error.message}`);

            if (error.code === -4046 || error.msg?.includes('No need to change margin type')) {
                console.log(`ℹ️ ${symbol} margin mode already set to: ${marginType}`);
                return { alreadySet: true };
            } else {
                console.error(`❌ Error setting margin mode for ${symbol}:`, error.msg || error.message);
                throw error; // ✅ Now throws the detailed error object
            }
        }
    }

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
        return await this.privateRequest('POST', '/fapi/v1/order', order);
    }

    async placeTakeProfitOrder(symbol, side, quantity, price, stopPrice) {
        const symbolInfo = await this.getSymbolInfo(symbol);
        const adjustedPrice = this.adjustPriceToTickSize(price, parseFloat(symbolInfo.filters.PRICE_FILTER.tickSize));
        const adjustedStopPrice = this.adjustPriceToTickSize(stopPrice, parseFloat(symbolInfo.filters.PRICE_FILTER.tickSize));

        const order = {
            symbol: symbol,
            side: side.toUpperCase(),
            type: 'TAKE_PROFIT',
            quantity: quantity.toString(),
            price: adjustedPrice.toString(),
            stopPrice: adjustedStopPrice.toString(),
            timeInForce: 'GTC'
        };
        console.log(`🔍 Placing TAKE_PROFIT order:`, order);
        return await this.privateRequest('POST', '/fapi/v1/order', order);
    }

    async placeTP_SL_BatchOrders(symbol, side, quantity, takeProfitPrice, stopLossPrice) {
        const symbolInfo = await this.getSymbolInfo(symbol);

        const adjustedTakeProfit = this.adjustPriceToTickSize(takeProfitPrice, parseFloat(symbolInfo.filters.PRICE_FILTER.tickSize));
        const adjustedStopLoss = this.adjustPriceToTickSize(stopLossPrice, parseFloat(symbolInfo.filters.PRICE_FILTER.tickSize));

        const orders = [];

        if (side === 'BUY') {
            orders.push({
                symbol: symbol,
                side: 'SELL',
                type: 'TAKE_PROFIT',
                quantity: quantity.toString(),
                price: adjustedTakeProfit.toString(),
                stopPrice: adjustedTakeProfit.toString(),
                timeInForce: 'GTC',
                priceProtect: 'TRUE'
            });

            orders.push({
                symbol: symbol,
                side: 'SELL',
                type: 'STOP_MARKET',
                quantity: quantity.toString(),
                stopPrice: adjustedStopLoss.toString(),
                timeInForce: 'GTC',
                priceProtect: 'TRUE'
            });
        } else {
            orders.push({
                symbol: symbol,
                side: 'BUY',
                type: 'TAKE_PROFIT',
                quantity: quantity.toString(),
                price: adjustedTakeProfit.toString(),
                stopPrice: adjustedTakeProfit.toString(),
                timeInForce: 'GTC',
                priceProtect: 'TRUE'
            });

            orders.push({
                symbol: symbol,
                side: 'BUY',
                type: 'STOP_MARKET',
                quantity: quantity.toString(),
                stopPrice: adjustedStopLoss.toString(),
                timeInForce: 'GTC',
                priceProtect: 'TRUE'
            });
        }

        const batchOrdersParam = JSON.stringify(orders);
        return await this.privateRequest('POST', '/fapi/v1/batchOrders', {
            batchOrders: batchOrdersParam
        });
    }

    // Utility methods
    generateSignature(queryString) {
        return crypto
            .createHmac('sha256', this.config.secretKey)
            .update(queryString)
            .digest('hex');
    }

    getTimestamp() {
        return Date.now().toString();
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

    adjustPriceToTickSize(price, tickSize) {
        const precision = Math.max(0, Math.ceil(-Math.log10(tickSize)));
        const adjusted = Math.floor(price / tickSize) * tickSize;
        return parseFloat(adjusted.toFixed(precision));
    }

    adjustQuantityToStepSize(quantity, stepSize) {
        if (stepSize >= 1) {
            return Math.floor(quantity / stepSize) * stepSize;
        }

        const precision = Math.max(0, Math.ceil(-Math.log10(stepSize)));
        const adjusted = Math.ceil(quantity / stepSize) * stepSize;
        return parseFloat(adjusted.toFixed(precision));
    }

    async calculateProperQuantity(symbol, price, minNotionalMultiplier = 1.1) {
        const symbolInfo = await this.getSymbolInfo(symbol);
        const minNotional = parseFloat(symbolInfo.filters.MIN_NOTIONAL.notional);
        const stepSize = parseFloat(symbolInfo.filters.LOT_SIZE.stepSize);
        const minQty = parseFloat(symbolInfo.filters.LOT_SIZE.minQty);

        const requiredNotional = minNotional * minNotionalMultiplier;
        let quantity = requiredNotional / price;
        quantity = Math.max(quantity, minQty);
        quantity = Math.ceil(quantity / stepSize) * stepSize;

        const finalNotional = quantity * price;
        if (finalNotional < minNotional) {
            quantity += stepSize;
        }

        return quantity;
    }

    getRateLimiterStats() {
        return {
            queueLength: this.rateLimiter.queue.length,
            running: this.rateLimiter.running,
            tokens: this.rateLimiter.tokens,
            burstLimit: this.rateLimiter.burstLimit
        };
    }
}

export default BinanceClient;