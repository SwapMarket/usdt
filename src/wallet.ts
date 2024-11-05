import { Transaction, TxOutput } from "liquidjs-lib";

const WALLET_API_URL = "http://localhost:1974";

export declare type UTXO = {
    TxId?: string;
    Vout?: number;
    PrivKey: string; // private key hex
    BlindingKey: string; // blinding private key hex
    value?: number; // Token or BTC amount
    token?: string; // TOKEN_TICKER or 'BTC'
    witness?: TxOutput; // fetched during unblind
    nonWitness?: Transaction; // for p2sh
};

// returns private and blinding keys for unspent outputs
export async function getUTXOs(): Promise<UTXO[] | null> {
    try {
        const response = await fetch(`${WALLET_API_URL}/utxos`, {
            signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) {
            return null;
        }
        return await response.json();
    } catch (error) {
        return null;
    }
}

// returns private and blinding keys for a new address
export async function getNewKeys(label: string): Promise<UTXO | null> {
    try {
        const response = await fetch(`${WALLET_API_URL}/keys?l=${label}`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
            return null;
        }
        return await response.json();
    } catch (error) {
        return null;
    }
}

// returns a new bech32m address
export async function getNewAddress(
    label: string,
    fallback: string,
): Promise<string> {
    try {
        const response = await fetch(`${WALLET_API_URL}/address?l=${label}`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) {
            return fallback;
        }
        return await response.text();
    } catch (error) {
        return fallback;
    }
}
