import log from "loglevel";

export class BitfinexWS {
    private ws: WebSocket;
    private ticker: string;
    private bids: Map<number, number>; // Track bids as price -> amount
    private asks: Map<number, number>; // Track asks as price -> amount
    private onPriceUpdate: (price: number | null) => void;

    // Reconnection settings
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 5;
    private reconnectDelay = 1000; // initial delay in ms, increases with each retry

    constructor(ticker: string, onPriceUpdate: (price: number | null) => void) {
        this.ticker = ticker;
        this.onPriceUpdate = onPriceUpdate;
    }

    // Connect and wait for WebSocket connection
    public async connect(): Promise<void> {
        this.ws = this.createWebSocket();

        // Wait for WebSocket to open
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error("WebSocket connection timeout"));
            }, 5000); // Set timeout for connection (e.g., 5 seconds)

            this.ws.onopen = () => {
                clearTimeout(timeout);
                this.handleOpen();
                resolve();
            };

            this.ws.onerror = (error) => {
                clearTimeout(timeout);
                reject(error);
            };
        });
    }

    // Helper to create a WebSocket with appropriate event handlers
    private createWebSocket(): WebSocket {
        const ws = new WebSocket("wss://api-pub.bitfinex.com/ws/2");

        ws.onmessage = (event) => this.handleMessage(event);
        ws.onclose = () => this.handleClose();

        return ws;
    }

    // Subscribe to the BTC/USDT order book
    private handleOpen() {
        log.info("WebSocket connected.");

        // Reset reconnect attempts upon successful connection
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;

        // Reset order book
        this.bids = new Map();
        this.asks = new Map();

        const msg = JSON.stringify({
            event: "subscribe",
            channel: "book",
            symbol: this.ticker,
            freq: "F0",
            prec: "P0",
        });
        this.ws.send(msg);
    }

    // Handle incoming WebSocket messages
    private handleMessage(event: MessageEvent) {
        const data = JSON.parse(event.data);

        // Handle snapshot (initial order book data)
        if (Array.isArray(data) && Array.isArray(data[1])) {
            if (Array.isArray(data[1][0])) {
                data[1].forEach((entry) => {
                    // Ensure entry has exactly three elements before processing
                    if (Array.isArray(entry) && entry.length === 3) {
                        this.processOrderBookUpdate(
                            entry as [number, number, number],
                        );
                    }
                });
            } else if (data[1].length === 3) {
                this.processOrderBookUpdate(
                    data[1] as [number, number, number],
                );
            }
            this.updateMidPrice();
        }
    }

    // Process order book updates and maintain the best bid/ask prices
    private processOrderBookUpdate(update: [number, number, number]) {
        const [price, count, amount] = update;

        if (count > 0) {
            if (amount > 0) {
                this.bids.set(price, amount);
            } else if (amount < 0) {
                this.asks.set(price, -amount);
            }
        } else {
            if (amount === 1) this.bids.delete(price);
            else if (amount === -1) this.asks.delete(price);
        }
    }

    // Calculate and display the mid-price from the best bid and ask prices
    private updateMidPrice() {
        const bestBid = Math.max(...this.bids.keys());
        const bestAsk = Math.min(...this.asks.keys());

        if (bestBid && bestAsk) {
            const midPrice = (bestBid + bestAsk) / 2;
            this.onPriceUpdate(midPrice);
        }
    }

    // Handle WebSocket close event and attempt reconnection
    private handleClose() {
        log.warn("WebSocket disconnected. Attempting to reconnect...");
        this.handleConnectionLost();

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;

            const reconnectTimeout =
                this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
            setTimeout(() => {
                log.info(`Reconnect attempt ${this.reconnectAttempts}`);
                this.connect().catch((error) => log.error(error)); // Attempt reconnection
            }, reconnectTimeout);
        } else {
            log.warn("Max reconnect attempts reached. Unable to reconnect.");
        }
    }

    // Handle connection lost by setting the price to null
    private handleConnectionLost() {
        this.onPriceUpdate(null);
    }
}
