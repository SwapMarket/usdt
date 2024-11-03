import { TxOutput } from "liquidjs-lib";

const WALLET_API_URL = "http://localhost:1974";
const TIMEOUT = 3000;

export declare type UTXO = {
    TxId?: string;
    Vout?: number;
    PrivKey: string; // private key hex
    BlindingKey: string; // blinding private key hex
    value?: number; // Token or BTC amount
    token?: string; // TOKEN_TICKER or 'BTC'
    witness?: TxOutput; // fetched during unblind
};

// returns private and blinding keys for unspent outputs
export async function getUTXOs(): Promise<UTXO[] | null> {
    try {
        const response = await fetch(`${WALLET_API_URL}/utxos`, {
            signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!response.ok) {
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error("Error fetching UTXOs:", error);
        return null;
    }
}

// returns private and blinding keys for a new address
export async function getNewKeys(label: string): Promise<UTXO | null> {
    try {
        const response = await fetch(`${WALLET_API_URL}/keys?l=${label}`, {
            signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!response.ok) {
            return null;
        }
        return await response.json();
    } catch (error) {
        console.error("Error fetching new keys:", error);
        return null;
    }
}

// returns a new bech32m address
export async function getNewAddress(label: string): Promise<string> {
    try {
        const response = await fetch(`${WALLET_API_URL}/address?l=${label}`, {
            signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!response.ok) {
            return null;
        }
        return await response.text();
    } catch (error) {
        console.error("Error fetching new address:", error);
        return null;
    }
}
