import { TxOutput } from "liquidjs-lib";

export declare type UTXO = {
    N?: number; // sequential number
    TxId?: string;
    Vout?: number;
    PubKey?: string; // base64 public key
    PubBlind?: string; // base64 blinding public key
    value?: number; // Token or BTC amount in sats
    token?: string; // TOKEN ticker or 'BTC'
    witness?: TxOutput; // fetched during unblind
};

export declare type WalletInfo = {
    Token: string; // is 'USD'
    TokenId: string; // asset id on Liduid network
    TokenName: string; // long name
    Ticker: string; // Bfx ticker
    MaxBuyBTC: number; // trade limit in BTC sats
    MaxBuyToken: number; // trade limit in BTC sats
    MinBuyBTC: number; // trade limit in BTC sats
    MinBuyToken: number; // trade limit in BTC sats
    FeeRatePPM: number; // traning fee as PPM
    FeeBaseSats: number; // fee base in sats to cover network cost
};

// Type guard function to check if an object is of type `UTXO`
export function isUTXO(obj: unknown): obj is UTXO {
    return (
        typeof obj === "object" &&
        obj !== null &&
        "TxId" in obj &&
        "Vout" in obj &&
        "N" in obj &&
        "PubKey" in obj &&
        "PubBlind" in obj &&
        typeof (obj as UTXO).TxId === "string" &&
        typeof (obj as UTXO).Vout === "number" &&
        typeof (obj as UTXO).N === "number" &&
        typeof (obj as UTXO).PubKey === "string" &&
        typeof (obj as UTXO).PubBlind === "string"
    );
}
