import ECPairFactory from "ecpair";
import {
    Transaction,
    TxOutput,
    address,
    networks,
    payments,
} from "liquidjs-lib";
import * as ecclib from "tiny-secp256k1";

const WALLET_API_URL = "http://localhost:1974";

export declare type UTXO = {
    TxId?: string;
    Vout?: number;
    PrivKey?: string; // private key hex
    BlindingKey?: string; // blinding private key hex
    value?: number; // Token or BTC amount
    token?: string; // TOKEN_TICKER or 'BTC'
    witness?: TxOutput; // fetched during unblind
    nonWitness?: Transaction; // for p2sh
};

declare type WalletInfo = {
    Token: string;
    TokenId: string;
    TokenName: string;
    MaxTradeSats: number;
    FeeRatePPM: number;
    FeeBaseSats: number;
    UTXOs: UTXO[];
}

export class Wallet {   
    // passed to constructor
    private onBalanceUpdate: () => void;
    private fetchValue: (utxo: UTXO) => void;
    private network: networks.Network;
    
    // fetched from a wallet API
    private walletUTXOs: UTXO[] | null = null;
    private depositKeys: UTXO | null = null;
    
    public token: string = " Loading..."; // short name, i.e "USD"
    public tokenId: string = " Loading..."; // asset Id
    public tokenName: string = " Loading...";
    public balanceBTC: number = 0;
    public balanceToken: number = 0;
    public feeRatePct: number = 0;
    public feeBaseSats: number = 0;
    public maxTradeSats: number = 0;

    constructor(
        network: networks.Network,
        onBalanceUpdate: () => void,
        fetchValue: (utxo: UTXO) => void,
    ) {
        this.network = network;
        this.onBalanceUpdate = onBalanceUpdate;
        this.fetchValue = fetchValue;
    }

    // fetch wallet info, including private and blinding keys for UTXOs
    public async getInfo(): Promise<void> {
        try {
            const response = await fetch(`${WALLET_API_URL}/info`, {
                signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) {
                console.error("Failed to fetch Info");
                throw new Error(
                    `Failed to fetch Info: ${response.statusText}`,
                );
            }
            const info: WalletInfo =  await response.json();

            this.token = info.Token
            this.tokenId = info.TokenId
            this.tokenName = info.TokenName
            this.feeRatePct = Number(info.FeeRatePPM) / 10_000;
            this.feeBaseSats = Number(info.FeeBaseSats);
            this.maxTradeSats = Number(info.MaxTradeSats);
        } catch (error) {
            console.error("Error fetching Info:", error);
            throw error;
        }
    }

    // fetch wallet private and blinding keys for UTXOs
    public async getUTXOs(): Promise<void> {
        try {
            const response = await fetch(`${WALLET_API_URL}/utxos`, {
                signal: AbortSignal.timeout(20000),
            });
            if (!response.ok) {
                console.error("Failed to fetch UTXOs");
                throw new Error(
                    `Failed to fetch UTXOs: ${response.statusText}`,
                );
            }
            this.walletUTXOs = await response.json();
        } catch (error) {
            console.error("Error fetching UTXOs:", error);
            throw error;
        }
    }

    // fetch private and blinding keys for a new address
    private async getNewKeys(label: string): Promise<UTXO | null> {
        try {
            const response = await fetch(`${WALLET_API_URL}/keys?l=${label}`, {
                signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) {
                console.error("Error fetching new keys:", response.statusText)
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error("Error fetching new keys:", error)
            return null;
        }
    }

    // Fetch private and blinding keys, then generate the deposit address.
    // They will be added to walletUTXOs upon funding,
    // because private keys may be needed for signing the withdrawal.
    // This ensures that the client gets the refund if funding exceeds prior balance
    public async getDepositAddress(): Promise<{
        confDepositAddress: string;
        explDepositAddress: string;
    }> {
        this.depositKeys = await this.getNewKeys("deposit");
        // Derive confidential deposit address
        const blindingPrivateKey = Buffer.from(
            this.depositKeys.BlindingKey,
            "hex",
        );
        const ECPair = ECPairFactory(ecclib);
        const blindingKeyPair = ECPair.fromPrivateKey(blindingPrivateKey);
        const blindingPublicKey = blindingKeyPair.publicKey;
        const keyPair = ECPair.fromWIF(this.depositKeys.PrivKey, this.network);

        // Generate explicit address using P2WPKH
        const explDepositAddress = payments.p2wpkh({
            pubkey: keyPair.publicKey,
            network: this.network,
        }).address!;

        // Convert to confidential
        const confDepositAddress = address.toConfidential(
            explDepositAddress,
            blindingPublicKey,
        );

        return { confDepositAddress, explDepositAddress };
    }

    // returns a new bech32m address
    public async getNewAddress(label: string): Promise<string | null> {
        try {
            const response = await fetch(
                `${WALLET_API_URL}/address?l=${label}`,
                {
                    signal: AbortSignal.timeout(3000),
                },
            );
            if (!response.ok) {
                console.error("Failed getting new address");
                return null;
            }
            return await response.text();
        } catch (error) {
            console.error("Error getting new address:", error);
            return null;
        }
    }

    public async calculateBalances() {
        if (!this.walletUTXOs) {
            return;
        }

        let balBTC = 0;
        let balToken = 0;

        for (let i = 0; i < this.walletUTXOs.length; i++) {
            await this.fetchValue(this.walletUTXOs[i]);
            if (this.walletUTXOs[i].value > 0) {
                if (this.walletUTXOs[i].token == "BTC") {
                    balBTC += this.walletUTXOs[i].value;
                } else {
                    balToken += this.walletUTXOs[i].value;
                }
            }
        }

        this.balanceBTC = balBTC;
        this.balanceToken =balToken;

        this.onBalanceUpdate();
    }

    public async recordDeposit(
        txid: string,
        vout: number,
    ): Promise<{ token: string; value: number }> {
        this.depositKeys.TxId = txid;
        this.depositKeys.Vout = vout;

        await this.fetchValue(this.depositKeys);

        if (this.walletUTXOs[this.walletUTXOs.length - 1].TxId != txid) {
            this.walletUTXOs.push(this.depositKeys);

            // refresh balances
            this.calculateBalances();
        }

        const token = this.depositKeys.token;
        const value = this.depositKeys.value;

        return { token, value };
    }

    // Prioritise smallest UTXOs to consolidate them
    // Excepton: when withdrawing TOKEN, pick the largest BTC UTXO for the fee payment
    public selectUTXOs(
        satsBTC: number,
        satsToken: number,
        satsFee: number,
    ): { selectedUTXOs: UTXO[]; totalBTC: number; totalToken: number } {
        let totalBTC = 0;
        let totalTOKEN = 0;
        let selectedUTXOs: UTXO[] = [];
        let leftToAllocate = satsToken;

        // sort BTC by increasing value
        let btcUTXOs = this.walletUTXOs
            .filter((utxo) => utxo.token === "BTC" && utxo.value !== undefined) // Filter by token and ensure `value` is defined
            .sort((a, b) => (a.value || 0) - (b.value || 0)); // Sort by `value` ascending

        // check if need to transfer TOKEN
        if (satsToken > 0) {
            const tokenUTXOs = this.walletUTXOs
                .filter(
                    (utxo) => utxo.token !== "BTC" && utxo.value !== undefined,
                ) // Filter by token and ensure `value` is defined
                .sort((a, b) => (a.value || 0) - (b.value || 0)); // Sort by `value` ascending

            for (const utxo of tokenUTXOs) {
                selectedUTXOs.push(utxo);
                leftToAllocate -= utxo.value!;
                totalTOKEN += utxo.value!;

                if (leftToAllocate <= 0) {
                    break;
                }
            }

            // re-sort to use the largest BTC UTXO to pay the network fee
            btcUTXOs = this.walletUTXOs
                .filter(
                    (utxo) => utxo.token === "BTC" && utxo.value !== undefined,
                ) // Filter by token and ensure `value` is defined
                .sort((a, b) => (b.value || 0) - (a.value || 0)); // Sort by `value` descending
        }

        leftToAllocate = satsBTC + satsFee;

        for (const utxo of btcUTXOs) {
            selectedUTXOs.push(utxo);
            leftToAllocate -= utxo.value!;
            totalBTC += utxo.value!;

            if (leftToAllocate <= 0) {
                break;
            }
        }

        return { selectedUTXOs, totalBTC, totalToken: totalTOKEN };
    }
}
