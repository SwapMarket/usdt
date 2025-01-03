export function toSats(amount: number): number {
    return Math.floor(amount * 100_000_000);
}

export function fromSats(amount: number): number {
    return amount / 100_000_000;
}

export function formatValue(value: number, token: string): string {
    let digits = 2;
    if (token == "BTC") {
        digits = 8;
    }
    if (token == "sats") {
        digits = 0;
    }

    return value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

export function scrambleArray<T>(array: T[]): T[] {
    // Create a copy to avoid mutating the original array
    const scrambled = array.slice();

    for (let i = scrambled.length - 1; i > 0; i--) {
        // Generate a random index
        const j = Math.floor(Math.random() * (i + 1));

        // Swap elements i and j
        [scrambled[i], scrambled[j]] = [scrambled[j], scrambled[i]];
    }

    return scrambled;
}

export class Counter {
    private count: number = 0;
    private max: number;

    constructor(max: number) {
        if (max <= 0) {
            throw new Error("Max value must be greater than zero.");
        }
        this.max = max;
    }

    iterate(): number {
        const currentValue = this.count;
        this.count = (this.count + 1) % this.max;
        return currentValue;
    }
}

export function isTxid(value: string): boolean {
    // Regular expression to match a 64-character hexadecimal string
    const txidRegex = /^[a-fA-F0-9]{64}$/;
    return txidRegex.test(value);
}

export function reverseHex(hex: string): string {
    return Buffer.from(hex, "hex").reverse().toString("hex");
}

const searchParams = () => new URLSearchParams(window.location.search);

export const getUrlParam = (name: string): string => {
    const param = searchParams().get(name);
    if (param) {
        resetUrlParam(name);
    }
    return param;
};

export const urlParamIsSet = (param: string) => param && param !== "";

export const resetUrlParam = (name: string) => {
    const params = searchParams();
    params.delete(name);

    window.history.replaceState(
        {},
        document.title,
        `${window.location.pathname}?${params.toString()}`,
    );
};
