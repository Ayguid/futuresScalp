class RateLimitedQueue {
    constructor(rateLimit, burstLimit, maxConcurrent = 20) {
        this.rateLimit = rateLimit;
        this.burstLimit = burstLimit;
        this.maxConcurrent = maxConcurrent;
        this.tokens = burstLimit;
        this.lastRefill = Date.now();
        this.queue = [];
        this.running = 0;
        this.waitingResolvers = []; // 🆕 Track waiting promises
    }

    refillTokens() {
        const now = Date.now();
        const timePassed = now - this.lastRefill;
        const refillAmount = (timePassed / 1000) * (this.rateLimit / 60);
        this.tokens = Math.min(this.burstLimit, this.tokens + refillAmount);
        this.lastRefill = now;
    }

    async waitForToken() {
        this.refillTokens();
        
        if (this.tokens > 0) {
            this.tokens--;
            return;
        }

        // 🆕 More efficient waiting using Promise resolution
        return new Promise((resolve) => {
            this.waitingResolvers.push(resolve);
        });
    }

    // 🆕 New method to notify waiting promises when tokens are available
    notifyWaiters() {
        this.refillTokens();
        
        while (this.waitingResolvers.length > 0 && this.tokens > 0) {
            const resolver = this.waitingResolvers.shift();
            this.tokens--;
            resolver();
        }
    }

    enqueue(fn) {
        this.queue.push(fn);
        this.dequeue();
    }

    async dequeue() {
        if (this.running >= this.maxConcurrent) return;

        const item = this.queue.shift();
        if (!item) return;

        this.running++;
        
        try {
            await this.waitForToken();
            item(async () => {
                this.running--;
                // 🆕 Notify waiters when a request completes
                this.notifyWaiters();
                this.dequeue();
            });
        } catch (error) {
            this.running--;
            this.notifyWaiters();
            this.dequeue();
        }
    }

}

export default RateLimitedQueue;