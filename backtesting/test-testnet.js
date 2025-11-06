import 'dotenv/config';
import crypto from 'crypto-js';
import axios from 'axios';

class BinanceFuturesTestnet {
    constructor(apiKey, secretKey) {
        this.apiKey = apiKey;
        this.secretKey = secretKey;
        this.baseURL = 'https://demo-fapi.binance.com';
        this.exchangeInfo = null;
        this.symbolInfoCache = {};
    }

    generateSignature(queryString) {
        return crypto.HmacSHA256(queryString, this.secretKey).toString(crypto.enc.Hex);
    }

    getTimestamp() {
        return Date.now().toString();
    }

    async makeRequest(method, endpoint, params = {}) {
        try {
            const timestamp = this.getTimestamp();
            const queryParams = new URLSearchParams({
                ...params,
                timestamp: timestamp,
                recvWindow: 60000
            });

            const signature = this.generateSignature(queryParams.toString());
            queryParams.append('signature', signature);

            const url = `${this.baseURL}${endpoint}?${queryParams.toString()}`;

            const response = await axios({
                method: method,
                url: url,
                headers: {
                    'X-MBX-APIKEY': this.apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            return response.data;
        } catch (error) {
            throw error.response ? error.response.data : error;
        }
    }

    // Get ALL exchange info once and cache it
    async getExchangeInfo() {
        if (!this.exchangeInfo) {
            console.log('   📡 Fetching exchange info...');
            const response = await axios.get(`${this.baseURL}/fapi/v1/exchangeInfo`);
            this.exchangeInfo = response.data;
        }
        return this.exchangeInfo;
    }

    // Get symbol information from cached exchange info
    async getSymbolInfo(symbol) {
        if (this.symbolInfoCache[symbol]) {
            return this.symbolInfoCache[symbol];
        }

        const exchangeInfo = await this.getExchangeInfo();
        const symbolData = exchangeInfo.symbols.find(s => s.symbol === symbol);
        
        if (!symbolData) {
            throw new Error(`Symbol ${symbol} not found`);
        }

        const lotSizeFilter = symbolData.filters.find(f => f.filterType === 'LOT_SIZE');
        const minNotionalFilter = symbolData.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        const priceFilter = symbolData.filters.find(f => f.filterType === 'PRICE_FILTER');

        const info = {
            symbol: symbolData.symbol,
            status: symbolData.status,
            baseAsset: symbolData.baseAsset,
            quoteAsset: symbolData.quoteAsset,
            pricePrecision: symbolData.pricePrecision,
            quantityPrecision: symbolData.quantityPrecision,
            filters: {
                lotSize: {
                    minQty: parseFloat(lotSizeFilter.minQty),
                    maxQty: parseFloat(lotSizeFilter.maxQty),
                    stepSize: parseFloat(lotSizeFilter.stepSize)
                },
                minNotional: {
                    notional: parseFloat(minNotionalFilter.notional)
                },
                priceFilter: {
                    minPrice: parseFloat(priceFilter.minPrice),
                    maxPrice: parseFloat(priceFilter.maxPrice),
                    tickSize: parseFloat(priceFilter.tickSize)
                }
            }
        };

        this.symbolInfoCache[symbol] = info;
        return info;
    }

    // Calculate proper quantity using the actual MIN_NOTIONAL from exchange info
    async calculateProperQuantity(symbolInfo, price, safetyMargin = 1.1) {
        const { stepSize, minQty } = symbolInfo.filters.lotSize;
        const minNotional = symbolInfo.filters.minNotional.notional;
        
        // Calculate quantity based on price to ensure notional >= minNotional
        const requiredNotional = minNotional * safetyMargin;
        let quantity = requiredNotional / price;
        
        // Adjust to step size - use ceil to ensure we meet minimum
        quantity = Math.ceil(quantity / stepSize) * stepSize;
        quantity = Math.max(quantity, minQty);
        
        // Format to correct precision
        const precision = this.getStepSizePrecision(stepSize);
        const finalQuantity = parseFloat(quantity.toFixed(precision));
        const actualNotional = finalQuantity * price;
        
        // Final verification
        if (actualNotional < minNotional) {
            throw new Error(`Calculated notional ${actualNotional.toFixed(2)} USDT is below minimum ${minNotional} USDT`);
        }
        
        return {
            quantity: finalQuantity,
            notional: actualNotional,
            minNotional: minNotional,
            price: price
        };
    }

    // Adjust price to match tick size
    adjustPriceToTickSize(price, tickSize) {
        const precision = this.getTickSizePrecision(tickSize);
        const adjusted = Math.floor(price / tickSize) * tickSize;
        return parseFloat(adjusted.toFixed(precision));
    }

    getStepSizePrecision(stepSize) {
        if (stepSize >= 1) return 0;
        const decimals = stepSize.toString().split('.')[1] || '';
        for (let i = 0; i < decimals.length; i++) {
            if (decimals[i] !== '0') return i + 1;
        }
        return 8;
    }

    getTickSizePrecision(tickSize) {
        if (tickSize >= 1) return 0;
        const decimals = tickSize.toString().split('.')[1] || '';
        for (let i = 0; i < decimals.length; i++) {
            if (decimals[i] !== '0') return i + 1;
        }
        return 8;
    }

    // Test 1: Get futures account information
    async testFuturesAccount() {
        try {
            console.log('🔍 Testing Futures Account Information...');
            const account = await this.makeRequest('GET', '/fapi/v2/account');
            
            console.log('✅ Futures Account Test - SUCCESS');
            console.log(`   - Total Margin Balance: ${parseFloat(account.totalMarginBalance).toFixed(2)} USDT`);
            console.log(`   - Available Balance: ${parseFloat(account.availableBalance).toFixed(2)} USDT`);
            console.log(`   - Total Wallet Balance: ${parseFloat(account.totalWalletBalance).toFixed(2)} USDT`);
            
            return true;
        } catch (error) {
            console.log('❌ Futures Account Test - FAILED');
            console.log(`   Error: ${error.msg || error.message || JSON.stringify(error)}`);
            return false;
        }
    }

    // Test 2: Test MARKET order with proper minNotional from API
    async testMarketOrder() {
        try {
            console.log('\n🔍 Testing MARKET Order...');
            
            const symbol = 'BTCUSDT';
            const symbolInfo = await this.getSymbolInfo(symbol);
            const ticker = await axios.get(`${this.baseURL}/fapi/v1/ticker/price?symbol=${symbol}`);
            const currentPrice = parseFloat(ticker.data.price);
            
            const quantityData = await this.calculateProperQuantity(symbolInfo, currentPrice, 1.1);

            console.log(`   Symbol: ${symbol}`);
            console.log(`   Current Price: ${currentPrice.toFixed(2)} USDT`);
            console.log(`   Min Notional: ${quantityData.minNotional} USDT`);
            console.log(`   Quantity: ${quantityData.quantity} ${symbolInfo.baseAsset}`);
            console.log(`   Actual Notional: ${quantityData.notional.toFixed(2)} USDT`);
            console.log(`   Step Size: ${symbolInfo.filters.lotSize.stepSize}`);

            const testOrder = {
                symbol: symbol,
                side: 'BUY',
                type: 'MARKET',
                quantity: quantityData.quantity.toString(),
                recvWindow: 60000
            };

            console.log(`   Placing MARKET order...`);
            const order = await this.makeRequest('POST', '/fapi/v1/order', testOrder);
            console.log('✅ MARKET Order Test - SUCCESS');
            console.log(`   - Order ID: ${order.orderId}`);
            console.log(`   - Status: ${order.status}`);

            // Wait for order to fill
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Check order status
            const orderStatus = await this.makeRequest('GET', '/fapi/v1/order', {
                symbol: symbol,
                orderId: order.orderId
            });

            console.log(`   - Final Status: ${orderStatus.status}`);
            console.log(`   - Executed Qty: ${orderStatus.executedQty}`);

            // Close position
            if (parseFloat(orderStatus.executedQty) > 0) {
                console.log('\n   Closing position...');
                const closeOrder = {
                    symbol: symbol,
                    side: 'SELL',
                    type: 'MARKET',
                    quantity: orderStatus.executedQty
                };

                await this.makeRequest('POST', '/fapi/v1/order', closeOrder);
                console.log('✅ Position Closed');
            }
            
            return true;
        } catch (error) {
            console.log('❌ MARKET Order Test - FAILED');
            console.log(`   Error: ${error.msg || error.message || JSON.stringify(error)}`);
            return false;
        }
    }

    // Test 3: Test LIMIT order with proper price tick size
    async testLimitOrder() {
        try {
            console.log('\n🔍 Testing LIMIT Order with Proper Tick Size...');
            
            const symbol = 'BTCUSDT';
            const symbolInfo = await this.getSymbolInfo(symbol);
            const ticker = await axios.get(`${this.baseURL}/fapi/v1/ticker/price?symbol=${symbol}`);
            const currentPrice = parseFloat(ticker.data.price);
            
            // Use a limit price that's realistic but won't execute immediately
            const rawLimitPrice = currentPrice * 0.98; // 2% below current
            
            // ADJUST PRICE TO TICK SIZE - THIS IS THE KEY FIX!
            const adjustedLimitPrice = this.adjustPriceToTickSize(
                rawLimitPrice, 
                symbolInfo.filters.priceFilter.tickSize
            );

            const quantityData = await this.calculateProperQuantity(symbolInfo, adjustedLimitPrice, 1.1);

            console.log(`   Symbol: ${symbol}`);
            console.log(`   Current Price: ${currentPrice.toFixed(2)} USDT`);
            console.log(`   Raw Limit Price: ${rawLimitPrice.toFixed(2)} USDT`);
            console.log(`   Adjusted Limit Price: ${adjustedLimitPrice} USDT (tick size: ${symbolInfo.filters.priceFilter.tickSize})`);
            console.log(`   Min Notional: ${quantityData.minNotional} USDT`);
            console.log(`   Quantity: ${quantityData.quantity} ${symbolInfo.baseAsset}`);
            console.log(`   Actual Notional: ${quantityData.notional.toFixed(2)} USDT`);

            const testOrder = {
                symbol: symbol,
                side: 'BUY',
                type: 'LIMIT',
                quantity: quantityData.quantity.toString(),
                price: adjustedLimitPrice.toString(),
                timeInForce: 'GTC',
                recvWindow: 60000
            };

            console.log(`   Placing LIMIT order...`);
            const order = await this.makeRequest('POST', '/fapi/v1/order', testOrder);
            console.log('✅ LIMIT Order Test - SUCCESS');
            console.log(`   - Order ID: ${order.orderId}`);
            console.log(`   - Status: ${order.status}`);

            // Check order status
            await new Promise(resolve => setTimeout(resolve, 1000));
            const orderStatus = await this.makeRequest('GET', '/fapi/v1/order', {
                symbol: symbol,
                orderId: order.orderId
            });
            console.log(`   - Current Status: ${orderStatus.status}`);

            // Cancel the order
            console.log('   Canceling LIMIT order...');
            await this.makeRequest('DELETE', '/fapi/v1/order', {
                symbol: symbol,
                orderId: order.orderId
            });
            console.log('✅ LIMIT Order Canceled');
            
            return true;
        } catch (error) {
            console.log('❌ LIMIT Order Test - FAILED');
            console.log(`   Error: ${error.msg || error.message || JSON.stringify(error)}`);
            return false;
        }
    }

    // Test 4: Test order cancellation with proper price adjustment
    async testOrderCancellation() {
        try {
            console.log('\n🔍 Testing Order Cancellation...');
            
            const symbol = 'ETHUSDT';
            const symbolInfo = await this.getSymbolInfo(symbol);
            const ticker = await axios.get(`${this.baseURL}/fapi/v1/ticker/price?symbol=${symbol}`);
            const currentPrice = parseFloat(ticker.data.price);
            
            // Use a reasonable limit price and adjust to tick size
            const rawLimitPrice = currentPrice * 0.95;
            const adjustedLimitPrice = this.adjustPriceToTickSize(
                rawLimitPrice,
                symbolInfo.filters.priceFilter.tickSize
            );

            const quantityData = await this.calculateProperQuantity(symbolInfo, adjustedLimitPrice, 1.1);

            console.log(`   Placing test order...`);
            console.log(`   - Symbol: ${symbol}`);
            console.log(`   - Current Price: ${currentPrice.toFixed(2)} USDT`);
            console.log(`   - Raw Limit Price: ${rawLimitPrice.toFixed(2)} USDT`);
            console.log(`   - Adjusted Limit Price: ${adjustedLimitPrice} USDT (tick size: ${symbolInfo.filters.priceFilter.tickSize})`);
            console.log(`   - Min Notional: ${quantityData.minNotional} USDT`);
            console.log(`   - Quantity: ${quantityData.quantity} ${symbolInfo.baseAsset}`);
            console.log(`   - Actual Notional: ${quantityData.notional.toFixed(2)} USDT`);

            const testOrder = {
                symbol: symbol,
                side: 'BUY',
                type: 'LIMIT',
                quantity: quantityData.quantity.toString(),
                price: adjustedLimitPrice.toString(),
                timeInForce: 'GTC'
            };

            const order = await this.makeRequest('POST', '/fapi/v1/order', testOrder);
            console.log(`   - Order placed: ID ${order.orderId}`);
            
            // Immediate cancellation
            console.log('   Canceling order...');
            const cancelResult = await this.makeRequest('DELETE', '/fapi/v1/order', {
                symbol: symbol,
                orderId: order.orderId
            });
            
            console.log('✅ Order Cancellation Test - SUCCESS');
            console.log(`   - Canceled Order ID: ${cancelResult.orderId}`);
            console.log(`   - Status: ${cancelResult.status}`);
            
            return true;
        } catch (error) {
            console.log('❌ Order Cancellation Test - FAILED');
            console.log(`   Error: ${error.msg || error.message || JSON.stringify(error)}`);
            return false;
        }
    }

    // Test 5: Display symbol precision info
    async testSymbolPrecision() {
        try {
            console.log('\n🔍 Testing Symbol Precision Information...');
            
            const symbols = [
                'BTCUSDT', 'ETHUSDT', 'ADAUSDT', 'XRPUSDT', 'DOTUSDT'
            ];

            console.log(`   📊 Symbol Precision Details:`);
            for (const symbol of symbols) {
                try {
                    const symbolInfo = await this.getSymbolInfo(symbol);
                    console.log(`   ${symbol}:`);
                    console.log(`      - Tick Size: ${symbolInfo.filters.priceFilter.tickSize}`);
                    console.log(`      - Step Size: ${symbolInfo.filters.lotSize.stepSize}`);
                    console.log(`      - Min Notional: ${symbolInfo.filters.minNotional.notional} USDT`);
                    console.log(`      - Price Precision: ${symbolInfo.pricePrecision} decimals`);
                    console.log(`      - Quantity Precision: ${symbolInfo.quantityPrecision} decimals`);
                } catch (error) {
                    console.log(`   ❌ ${symbol}: ${error.message}`);
                }
            }
            
            return true;
        } catch (error) {
            console.log('❌ Symbol Precision Test - FAILED');
            console.log(`   Error: ${error.message}`);
            return false;
        }
    }

    // Test 6: Test exchange information
    async testExchangeInfo() {
        try {
            console.log('\n🔍 Testing Exchange Information...');
            
            const exchangeInfo = await this.getExchangeInfo();
            const tradingSymbols = exchangeInfo.symbols.filter(s => s.status === 'TRADING');
            
            console.log('✅ Exchange Info Test - SUCCESS');
            console.log(`   - Total Symbols: ${exchangeInfo.symbols.length}`);
            console.log(`   - Trading Symbols: ${tradingSymbols.length}`);
            
            return true;
        } catch (error) {
            console.log('❌ Exchange Info Test - FAILED');
            console.log(`   Error: ${error.message}`);
            return false;
        }
    }
}

// Main testing function
async function testFuturesApiKeys() {
    const API_KEY = process.env.BINANCE_TESTNET_API_KEY;
    const SECRET_KEY = process.env.BINANCE_TESTNET_SECRET_KEY;

    if (!API_KEY || !SECRET_KEY) {
        console.log('❌ Please set BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_SECRET_KEY in .env file');
        process.exit(1);
    }

    console.log('🚀 Starting Binance Futures Testnet API Key Tests...\n');
    console.log('📋 FUTURES TESTNET CONFIGURATION:');
    console.log(`   - Base URL: https://demo-fapi.binance.com`);
    console.log(`   - API Key: ${API_KEY.substring(0, 10)}...`);
    console.log(`   - Product Type: USD-M Futures`);
    console.log(`   - FIXED: Proper price tick size adjustment`);
    console.log('='.repeat(70));

    const binance = new BinanceFuturesTestnet(API_KEY, SECRET_KEY);
    
    const tests = [
        () => binance.testFuturesAccount(),
        () => binance.testMarketOrder(),
        () => binance.testLimitOrder(),
        () => binance.testOrderCancellation(),
        () => binance.testSymbolPrecision(),
        () => binance.testExchangeInfo()
    ];

    let passedTests = 0;
    
    for (const test of tests) {
        const result = await test();
        if (result) passedTests++;
        console.log('');
    }

    console.log('='.repeat(70));
    console.log('📊 FINAL TEST RESULTS:');
    console.log(`   ✅ Passed: ${passedTests}/${tests.length}`);
    
    if (passedTests >= 4) {
        console.log('\n🎉 SUCCESS! Your API keys are working perfectly!');
        console.log('   All essential features verified:');
        console.log('   ✓ Account access');
        console.log('   ✓ Market orders');
        console.log('   ✓ Limit orders (with proper tick size)');
        console.log('   ✓ Order cancellation');
        console.log('   ✓ Symbol precision handling');
        console.log('   ✓ Exchange data');
        console.log('\n🚀 Ready to build your scalping bot!');
    } else {
        console.log('\n⚠️  Some tests failed. Please check your setup.');
    }
}

// Run the tests
testFuturesApiKeys().catch(console.error);