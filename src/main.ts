import zkp, { Secp256k1ZKP } from "@vulpemventures/secp256k1-zkp";
import ECPairFactory from "ecpair";
import {
    AssetHash,
    Blinder,
    Creator,
    Extractor,
    Finalizer,
    OwnedInput,
    Pset,
    Transaction,
    Updater,
    UpdaterInput,
    UpdaterOutput,
    ZKPGenerator,
    ZKPValidator,
    address,
    confidential,
    networks,
    payments,
    script,
} from "liquidjs-lib";
import * as ecclib from "tiny-secp256k1";

import { BitfinexWS } from "./bitfinex";
import "./style.css";
import {
    Counter,
    formatValue,
    fromSats,
    isTxid,
    reverseHex,
    scrambleArray,
    setInnerHTML,
} from "./utils";
import { UTXO, getNewAddress, getNewKeys, getUTXOs } from "./wallet";

// wait 10 seconds to connect debugger
//await new Promise((f) => setTimeout(f, 10000));

// constants
const NETWORK = networks.testnet;
const ESPLORA_URL = "https://blockstream.info/liquidtestnet";
const ESPLORA_API_URL = ESPLORA_URL + "/api";
const DUST_BTC = 495; // mimimum possible UTXO
const DUST_TOKEN = 2_000_000; // less than tx fee, 20 BTC sats at 70k roughly
const FEE_BASE = 40; // initial guess for onchain fee
const FEE_RATE = 0.5; // pct markup to mid price
const TOKEN_NAME = "PEGx USDt Testnet";
const TOKEN = "USD";
const ASSET_ID = new Map<string, string>([
    ["BTC", NETWORK.assetHash],
    [TOKEN, "b612eb46313a2cd6ebabd8b7a8eed5696e29898b87a43bff41c94f51acef9d73"],
]);
const BITFINEX_TICKER = "tBTCUST"; // BTC/USDT ticker symbol for Bitfinex
const TITLE_TICKER = "BTC/USDt"; // to update window.title
const MAX_TRADE_SATS = 10_000_000;

// fetched from a masked API
let walletUTXOs: UTXO[] | null = null;
let depositKeys: UTXO | null = null;

// Global variables
let exchangeRate: number | null = null;
let hasError = false;
let balanceBTC: number = 0;
let balanceTOKEN: number = 0;
let withdrawalPending: boolean = false;
let withdrawalComplete: boolean = false;
let confi: confidential.Confidential;
let secp: Secp256k1ZKP;
let zkpValidator: ZKPValidator;
let mainOutput = 0; // used to show the unblinded tx in explorer
let mainNonce: Buffer; // used to show the unblinded tx in explorer
let confDepositAddress = "";
let explDepositAddress = "";
let withdrawalAddress = "";
let withdrawalStatus= "Awaiting deposit...";
let interval: NodeJS.Timeout;

const ERROR_MESSAGE = `
    <div style="text-align: center;">
        <h2>Error connecting to the exchange</h2>
        <p>We're experiencing issues loading the necessary information. Please try again later.</p>
    </div>`;

// Initialize the Bitfinex WebSocket with callback to update exchangeRate
const bitfinexWS = new BitfinexWS(BITFINEX_TICKER, updateExchangeRate);

try {
    // Attempt to connect and wait until connection is established
    await bitfinexWS.connect();

    // get private keys for blinding and signing the withdrawal
    getUTXOs().then((utxos) => {
        walletUTXOs = utxos;
        calculateBalances();
    });
} catch (error) {
    console.error("Failed to connect:", error);
    hasError = true;
}

// Initialize blinder
secp = await zkp();
confi = new confidential.Confidential(secp);
zkpValidator = new ZKPValidator(secp);

const HTML_BODY = () => { return `
    <div>
        <p>* Testnet *</p>
        <h1>Liquid ${TITLE_TICKER} Swaps</h1>   
        <p>Send L-BTC (max <span id="maxBTC"> Calculating...</span>) to receive ${TOKEN_NAME}</p>
        <p>Send ${TOKEN_NAME} (max $<span id="maxTOKEN"> Calculating...</span>) to receive L-BTC</p>
        <p>Exchange Rate: 1 BTC = <span id="rate">Loading...</span> ${TOKEN}</p>
        <p>Fee Rate: ${formatValue(FEE_RATE, "")}% + ${FEE_BASE} sats</p>
        <label for="return-address">Step 1. Paste your confidential withdrawal address:</label>
        <br><br>
        <input
            autocomplete="off"
            type="text"
            size="110em"
            id="return-address"
            placeholder="Paste your withdrawal address here"
            value="${withdrawalAddress}"
        />
        <div id="hiddenContent" style="display:${withdrawalAddress?'block':'none'}">
            <p>Step 2. Fund this address with Liquid BTC or ${TOKEN_NAME}:</p>
            <p id="depositAddress">${confDepositAddress?confDepositAddress:" Deriving..."}</p>
            <p>*** Keep this page open and do not refresh ***</p>
            <p id="status">${withdrawalStatus}</p>
        </div>
        <p id="transaction"></p>
    </div>`};

// Render page
document.querySelector<HTMLDivElement>("#app")!.innerHTML = hasError
    ? ERROR_MESSAGE
    : HTML_BODY();

// add listener to the input field
if (!hasError) {
    const inputField = document.getElementById("return-address");
    const contentToToggle = document.getElementById("hiddenContent");

    // Function to toggle visibility based on input value
    function toggleContentVisibility() {
        // verify address
        if (inputField) {
            const addr = (inputField as HTMLInputElement).value;
            if (addr) {
                try {
                    if (address.isConfidential(addr)) {
                        contentToToggle.style.display = "block";
                        withdrawalAddress = addr;
                        setInnerHTML("transaction", ``);
                        showDepositAddress();
                        return;
                    }
                } catch (error) {
                    console.error(error);
                }

                // invalid withdrawal address
                setInnerHTML(
                    "transaction",
                    `Please provide confidential withdrawal address!`,
                );
                return;
            }
        }

        contentToToggle.style.display = "none";
    }

    if (inputField) {
        // Add event listener for the 'change' event
        inputField.addEventListener("change", toggleContentVisibility);

        // Listen for paste events as well
        inputField.addEventListener("paste", () => {
            setTimeout(toggleContentVisibility, 0); // Delay to ensure the pasted content is read
        });
    }
}

// Fetch private and blinding keys to generate the deposit address.
// They will be added to walletUTXOs upon funding,
// because private keys may be needed for signing the withdrawal.
// This ensures that the client gets the refund if not enough funds in
// the wallet UTXOs by the time his deposit arrives
function getDepositAddress() {
    getNewKeys("deposit").then((keys) => {
        // set global variable
        depositKeys = keys;

        // Derive confidential deposit address
        const blindingPrivateKey = Buffer.from(depositKeys.BlindingKey, "hex");
        const ECPair = ECPairFactory(ecclib);
        const blindingKeyPair = ECPair.fromPrivateKey(blindingPrivateKey);
        const blindingPublicKey = blindingKeyPair.publicKey;
        const keyPair = ECPair.fromWIF(depositKeys.PrivKey, NETWORK);

        // Generate explicit address using P2WPKH
        explDepositAddress = payments.p2wpkh({
            pubkey: keyPair.publicKey,
            network: NETWORK,
        }).address!;

        // Convert to confidential
        confDepositAddress = address.toConfidential(
            explDepositAddress,
            blindingPublicKey,
        );

        showDepositAddress();
    });
}

function showDepositAddress() {
    if (confDepositAddress) {
        // show on the web page
        let element = document.getElementById("depositAddress");
        if (element) {
            element.textContent = confDepositAddress;

            // Start polling for transactions every 5 seconds
            interval = setInterval(pollForTransactions, 5000);
        }
    } else {
        getDepositAddress();
    }
}

// Function to update the global exchangeRate
function updateExchangeRate(price: number | null) {
    exchangeRate = price;

    if (!exchangeRate || hasError) {
        // Update the HTML content to display an error message
        const appElement = document.querySelector<HTMLDivElement>("#app");
        if (appElement) {
            appElement.innerHTML = ERROR_MESSAGE;
        }
        return;
    } else {
        const appElement = document.querySelector<HTMLDivElement>("#app");
        if (appElement && appElement.innerHTML == ERROR_MESSAGE) {
            // Update the HTML content to display as normal
            appElement.innerHTML = HTML_BODY();
        }
    }

    let priceText = formatValue(exchangeRate, "USD");
    let element = document.getElementById("rate");
    if (element) {
        element.textContent = priceText;
    }

    // Update the document title with the mid-price
    document.title = `${priceText} ${TITLE_TICKER}`;
}

async function calculateBalances() {
    if (!walletUTXOs) {
        return;
    }

    let balBTC = 0;
    let balTOKEN = 0;

    for (let i = 0; i < walletUTXOs.length; i++) {
        await fetchValue(walletUTXOs[i]);
        if (walletUTXOs[i].value > 0) {
            if (walletUTXOs[i].token == "BTC") {
                balBTC += walletUTXOs[i].value;
            } else {
                balTOKEN += walletUTXOs[i].value;
            }
        }
    }

    // update global vars
    balanceBTC = balBTC;
    balanceTOKEN = balTOKEN;

    let element = document.getElementById("maxBTC");
    if (element) {
        // 1% cushion and round to 1k sats
        const maxBTC = Math.min(
            MAX_TRADE_SATS,
            Math.floor(((balanceTOKEN / exchangeRate) * 0.99) / 1_000) * 1_000,
        );
        element.textContent =
            maxBTC.toLocaleString("en-US", {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
            }) + " sats";
    }

    element = document.getElementById("maxTOKEN");
    if (element) {
        // 1% cushion and round to 1$
        const maxTOKEN = Math.floor(
            fromSats(
                Math.min(MAX_TRADE_SATS, balanceBTC) * exchangeRate * 0.99,
            ),
        );
        element.textContent = formatValue(maxTOKEN, "USD");
    }
}

async function unblindUTXO(
    utxo: UTXO,
): Promise<confidential.UnblindOutputResult> {
    // get raw hex
    const response = await fetch(`${ESPLORA_API_URL}/tx/${utxo.TxId}/hex`);
    const txHex = await response.text();

    // Process the transaction details
    const tx = Transaction.fromHex(txHex);
    const unblindedOutput = confi.unblindOutputWithKey(
        tx.outs[utxo.Vout],
        Buffer.from(utxo.BlindingKey, "hex"),
    );
    // add witness
    utxo.witness = tx.outs[utxo.Vout];

    return unblindedOutput;
}

async function fetchValue(utxo: UTXO) {
    const unblindedOutput = await unblindUTXO(utxo);
    const assetId = AssetHash.fromBytes(unblindedOutput.asset).hex;
    let token = "";
    let value = 0;

    // map the asset id to token ticker
    for (let key of ASSET_ID.keys()) {
        if (ASSET_ID.get(key) == assetId) {
            token = key;
            value = Number(unblindedOutput.value);
            break;
        }
    }

    // update UTXO object
    utxo.token = token;
    utxo.value = value;
}

// Polling function to check for deposit arrival
async function pollForTransactions() {
    if (withdrawalPending || withdrawalComplete) {
        return;
    }

    try {
        const response = await fetch(
            `${ESPLORA_API_URL}/address/${confDepositAddress}/txs`,
        );
        const transactions = await response.json();

        if (transactions.length > 0) {
            const depositTx = transactions[0];

            if (depositTx.status.confirmed) {
                // find output number
                let vout = 0;
                for (const output of depositTx.vout) {
                    if (output.scriptpubkey_address === explDepositAddress) {
                        break;
                    }
                    vout++;
                }

                // fetch asset and value
                depositKeys.TxId = depositTx.txid;
                depositKeys.Vout = vout;
                await fetchValue(depositKeys);

                const token = depositKeys.token;
                const value = depositKeys.value; 
                
                if (depositKeys.value > 0) {
                    const senderAddress =
                        depositTx.vin[0].prevout.scriptpubkey_address;
                    const formattedValue = formatValue(fromSats(value), token);

                    setStatus(`Received ${formattedValue} ${depositKeys.token} from ${senderAddress}`);

                    const addressElement = document.getElementById(
                        "return-address",
                    ) as HTMLInputElement | null;

                    if (addressElement && !withdrawalAddress) {
                        withdrawalAddress = addressElement.value;
                    }

                    if (
                        !withdrawalAddress ||
                        !address.isConfidential(withdrawalAddress) ||
                        withdrawalAddress == confDepositAddress
                    ) {
                        // invalid withdrawal address
                        setInnerHTML(
                            "transaction",
                            `Please provide confidential withdrawal address!`,
                        );
                        return;
                    }

                    withdrawalPending = true;

                    // amounts to be sent back
                    let withdrawBTC = 0; // in sats
                    let withdrawTOKEN = 0; // in sats

                    if (!exchangeRate) {
                        // Exception: exchangeRate not set
                        setStatus(
                            `ERROR! Exchange rate is not available, preceeding with refund.`,
                            true,
                        );
                        if (token == "BTC") {
                            withdrawBTC = value;
                        } else {
                            withdrawTOKEN = value;
                        }
                    } else {
                        // Fix rate and compute withdrawal
                        const fixedRate = exchangeRate;

                        // we sold BTC
                        let feeDirection = "+";
                        let bumpedRate = Math.round(
                            exchangeRate * (1 + FEE_RATE / 100),
                        );
                        withdrawBTC = Math.floor(value / bumpedRate) - FEE_BASE;
                        withdrawTOKEN = 0;

                        if (token == "BTC") {
                            // we bough BTC
                            feeDirection = "-";
                            bumpedRate = Math.round(
                                exchangeRate * (1 - FEE_RATE / 100),
                            );
                            withdrawTOKEN = Math.floor(
                                (value - FEE_BASE) * bumpedRate,
                            );
                            withdrawBTC = 0;
                        }

                        setStatus(
                            `Exchange rate fixed at ${formatValue(fixedRate, "USD")} ${feeDirection} ${formatValue(FEE_RATE, "")}% = ${formatValue(bumpedRate, "USD")}`,
                            true,
                        );

                        // verify reserves
                        const reserveBTC =
                            balanceBTC - FEE_BASE * 2 - DUST_BTC * 2;

                        if (withdrawTOKEN > balanceTOKEN) {
                            // wants to withdraw too much TOKEN, refund some BTC
                            withdrawBTC = Math.min(
                                reserveBTC,
                                Math.floor(
                                    (withdrawTOKEN - balanceTOKEN) / bumpedRate,
                                ),
                            );
                            withdrawTOKEN = balanceTOKEN;
                            setStatus(
                                `Not enough ${TOKEN_NAME} balance. Processing refund of BTC...`,
                                true,
                            );
                        }

                        if (withdrawBTC > reserveBTC) {
                            // wants to withdraw too much BTC, refund some TOKEN
                            withdrawTOKEN = Math.min(
                                balanceTOKEN,
                                Math.floor(
                                    (withdrawBTC - reserveBTC) * bumpedRate,
                                ),
                            );
                            withdrawBTC = reserveBTC;
                            setStatus(
                                `Not enough BTC balance. Processing refund of ${TOKEN_NAME}...`,
                                true,
                            );
                        }
                    }

                    // add new UTXO to the list
                    if (
                        walletUTXOs[walletUTXOs.length - 1].TxId !=
                        depositTx.txid
                    ) {
                        depositKeys.token = token;
                        depositKeys.value = value;
                        walletUTXOs.push(depositKeys);

                        // refresh balances and unblind UTXOs
                        await calculateBalances();
                    }

                    let textAmount = "";

                    if (withdrawTOKEN > 0) {
                        textAmount =
                            formatValue(fromSats(withdrawTOKEN), "USD") +
                            " " +
                            TOKEN_NAME;
                    }

                    if (withdrawBTC > 0) {
                        const t =
                            formatValue(fromSats(withdrawBTC), "BTC") + " BTC";
                        if (textAmount) {
                            textAmount += " + " + t;
                        } else {
                            textAmount = t;
                        }
                    }

                    setStatus(`Sending ${textAmount} to ${address.fromConfidential(withdrawalAddress).unconfidentialAddress}`, true);
                    setInnerHTML("transaction", ``);

                    const success = await processWithdrawal(
                        withdrawalAddress,
                        withdrawBTC,
                        withdrawTOKEN,
                    );

                    if (success) {
                        withdrawalComplete = true;
                        clearInterval(interval);
                    } else {
                        // refresh wallet UTXOs to try again
                        setInnerHTML(
                            "transaction",
                            `<br><br>Refreshing wallet balances...`,
                            true,
                        );
                        walletUTXOs = await getUTXOs();
                        await calculateBalances();
                    }
                } else {
                    setStatus(`Ineligible token ignored...`);
                }
            } else {
                setStatus(
                    `Deposit is in mempool, awaiting confirmation...`,
                );
            }
        }
    } catch (error) {
        console.error("Error:", error);
    }

    withdrawalPending = false;
}

// Process the withdrawal
async function processWithdrawal(
    toAddress: string,
    satsBTC: number,
    satsTOKEN: number,
): Promise<boolean> {
    // select UTXOs and get total value they pay
    let satsFee = FEE_BASE;
    let tx: Transaction;

    // Generate return addresses for change
    const btcChangeAddress = await getNewAddress(
        "BTC_change",
        confDepositAddress,
    );

    let tokenChangeAddress = btcChangeAddress;

    if (satsTOKEN > 0 && satsTOKEN < balanceTOKEN) {
        // get a unique address
        tokenChangeAddress = await getNewAddress(
            `${TOKEN}_change`,
            btcChangeAddress,
        );
    }

    // try a maximum of 3 times to optimize the fee
    for (let i = 0; i < 3; i++) {
        // Create the withdrawal Transaction
        tx = await prepareTransaction(
            toAddress,
            satsBTC,
            satsTOKEN,
            satsFee,
            btcChangeAddress,
            tokenChangeAddress,
        );

        if (!tx) {
            return false;
        }

        const vSize = tx.virtualSize(true);
        const optimalFee = Math.ceil(vSize / 10);

        if (satsFee == optimalFee) {
            break;
        }

        satsFee = optimalFee;
    }

    const txHex = tx.toHex();

    // Broadcast the transaction
    const result = await broadcastTransaction(txHex);

    if (isTxid(result)) {
        // unblind the main output to show the link
        let blinded = "";

        try {
            const tx = Transaction.fromHex(txHex);
            const out = tx.outs[mainOutput];
            const unblindedOutput = confi.unblindOutputWithNonce(
                out,
                mainNonce,
            );
            const value = unblindedOutput.value.toString();
            const asset = reverseHex(unblindedOutput.asset.toString("hex"));
            const valueBlinder = reverseHex(
                unblindedOutput.valueBlindingFactor.toString("hex"),
            );
            const assetBlinder = reverseHex(
                unblindedOutput.assetBlindingFactor.toString("hex"),
            );
            blinded = `#blinded=${value},${asset},${valueBlinder},${assetBlinder}`;
        } catch (error) {
            console.error("Failed to unblind output:", error);
        }

        setInnerHTML(
            "transaction",
            `TxId: <a href="${ESPLORA_URL}/tx/${result}${blinded}" target="_blank">${result}</a>`,
        );

        setInnerHTML("transaction", `<br><br><a href="/">New Swap</a>`, true);

        return true;
    } else {
        setInnerHTML("transaction", `Error: ${result}`);
        return false;
    }
}

// Create the transaction
async function prepareTransaction(
    toAddress: string, // withdrawal address
    satsBTC: number,
    satsTOKEN: number,
    satsFee: number,
    btcChangeAddress: string,
    tokenChangeAddress: string,
): Promise<Transaction | null> {
    const pset = Creator.newPset();
    const ins: UpdaterInput[] = [];
    let outs: UpdaterOutput[] = [];

    // Select UTXOs
    const { selectedUTXOs, totalBTC, totalTOKEN } = selectUTXOs(
        satsBTC,
        satsTOKEN,
        satsFee,
    );

    // Add the selected UTXOs as inputs
    for (const utxo of selectedUTXOs) {
        // this only works with p2wph
        // if receive p2sh (change from SideSwap deposit)
        //
        ins.push({
            txid: utxo.TxId,
            txIndex: utxo.Vout,
            sighashType: Transaction.SIGHASH_ALL,
            witnessUtxo: utxo.witness,
        });
    }

    // Use every input to blind some output
    const numBlinders = selectedUTXOs.length;
    let counter = new Counter(numBlinders);

    if (satsTOKEN > 0) {
        // add TOKEN output
        outs.push({
            asset: ASSET_ID.get(TOKEN)!,
            amount: satsTOKEN,
            script: address.toOutputScript(toAddress, NETWORK),
            blinderIndex: counter.iterate(),
            blindingPublicKey: address.fromConfidential(toAddress).blindingKey,
        });

        // Add the TOKEN change output
        if (totalTOKEN - satsTOKEN > DUST_TOKEN) {
            outs.push({
                asset: ASSET_ID.get(TOKEN)!,
                amount: totalTOKEN - satsTOKEN,
                script: address.toOutputScript(tokenChangeAddress, NETWORK),
                blinderIndex: counter.iterate(),
                blindingPublicKey:
                    address.fromConfidential(tokenChangeAddress).blindingKey,
            });
        }
    }

    if (satsBTC > 0) {
        // add BTC output and change
        outs.push({
            asset: ASSET_ID.get("BTC")!,
            amount: satsBTC,
            script: address.toOutputScript(toAddress, NETWORK),
            blinderIndex: counter.iterate(),
            blindingPublicKey: address.fromConfidential(toAddress).blindingKey,
        });
    }

    // Add the change output in BTC
    const changeBTC = totalBTC - satsBTC - satsFee;
    if (changeBTC > DUST_BTC) {
        outs.push({
            asset: ASSET_ID.get("BTC")!,
            amount: changeBTC,
            script: address.toOutputScript(btcChangeAddress, NETWORK),
            blinderIndex: counter.iterate(),
            blindingPublicKey:
                address.fromConfidential(btcChangeAddress).blindingKey,
        });
    }

    // 1 input and 1 output can't be blinded, split the output in 2
    if (ins.length == 1 && outs.length == 1) {
        const splitAmount = Math.floor(outs[0].amount / 2);
        outs[0].amount -= splitAmount;
        outs.push({
            asset: outs[0].asset,
            amount: splitAmount,
            script: outs[0].script!,
            blinderIndex: counter.iterate(),
            blindingPublicKey: outs[0].blindingPublicKey,
        });
    }

    // improve privacy by scrambling outputs
    outs = scrambleArray(outs);

    // Add the fee output
    outs.push({
        asset: ASSET_ID.get("BTC")!,
        amount: satsFee,
    });

    // build the tx
    const updater = new Updater(pset);
    updater.addInputs(ins).addOutputs(outs);

    // Enumerate owned inputs
    let ownedInputs: OwnedInput[] = [];

    for (let i = 0; i < numBlinders; i++) {
        const unblindedOutput = await unblindUTXO(
            selectedUTXOs[i],
        );

        ownedInputs.push({
            asset: unblindedOutput.asset,
            assetBlindingFactor: unblindedOutput.assetBlindingFactor,
            valueBlindingFactor: unblindedOutput.valueBlindingFactor,
            value: unblindedOutput.value,
            index: i,
        });
    }

    // find the output indexes to blind
    const outputIndexes = [];
    for (const [index, output] of pset.outputs.entries()) {
        if (output.blindingPubkey) {
            outputIndexes.push(index);
        }
    }

    // blind the Pset
    const zkpGenerator = new ZKPGenerator(
        secp,
        ZKPGenerator.WithOwnedInputs(ownedInputs),
    );
    const ECPair = ECPairFactory(secp.ecc);
    const blinder = new Blinder(pset, ownedInputs, zkpValidator, zkpGenerator);
    const outputBlindingArgs = zkpGenerator.blindOutputs(
        pset,
        Pset.ECCKeysGenerator(secp.ecc),
        outputIndexes,
    );
    if (outputBlindingArgs.length) {
        blinder.blindLast({ outputBlindingArgs });

        const script = address.fromConfidential(toAddress).scriptPubKey;
        const toHexString = (array: Uint8Array): string => {
            return Array.from(array)
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
        };

        // find index of the output that pays to the withdrawal address
        for (const [index, output] of outs.entries()) {
            if (toHexString(output.script) === toHexString(script)) {
                mainOutput = index;
                break;
            }
        }

        // find the nonce of the main output
        for (const arg of outputBlindingArgs) {
            if (arg.index == mainOutput) {
                mainNonce = arg.nonce;
                break;
            }
        }
    }

    // sign inputs
    pset.inputs.forEach((input, index) => {
        // Generate input preimage for signing
        const sighash = Transaction.SIGHASH_ALL;
        const preimage = pset.getInputPreimage(index, sighash);
        const keyPair = ECPair.fromWIF(selectedUTXOs[index].PrivKey, NETWORK);

        // Generate the ECDSA signature for the input using your ECC library
        const signature = ecclib.sign(
            new Uint8Array(preimage),
            Uint8Array.from(keyPair.privateKey!),
        );

        // Attach signature to the input as a partial signature
        const partialSig = {
            pubkey: keyPair.publicKey,
            signature: script.signature.encode(Buffer.from(signature), sighash),
        };

        pset.inputs[index].partialSigs = pset.inputs[index].partialSigs || [];
        pset.inputs[index].partialSigs.push(partialSig);
    });

    // Finalize pset
    const finalizer = new Finalizer(pset);
    finalizer.finalize();
    if (!finalizer.pset.isComplete()) {
        return null;
    }

    // Return the Transaction
    return Extractor.extract(finalizer.pset);
}

// The algorithm is simple:
// Prioritise smallest UTXOs to consolidate them
// Excepton: when withdrawing TOKEN, pick the largest BTC UTXO for the fee payment
function selectUTXOs(
    satsBTC: number,
    satsTOKEN: number,
    satsFee: number,
): { selectedUTXOs: UTXO[]; totalBTC: number; totalTOKEN: number } {
    let totalBTC = 0;
    let totalTOKEN = 0;
    let selectedUTXOs: UTXO[] = [];
    let leftToAllocate = satsTOKEN;

    // sort BTC by increasing value
    let btcUTXOs = walletUTXOs
        .filter((utxo) => utxo.token === "BTC" && utxo.value !== undefined) // Filter by token and ensure `value` is defined
        .sort((a, b) => (a.value || 0) - (b.value || 0)); // Sort by `value` ascending

    // check if need to transfer TOKEN
    if (satsTOKEN > 0) {
        const tokenUTXOs = walletUTXOs
            .filter((utxo) => utxo.token === TOKEN && utxo.value !== undefined) // Filter by token and ensure `value` is defined
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
        btcUTXOs = walletUTXOs
            .filter((utxo) => utxo.token === "BTC" && utxo.value !== undefined) // Filter by token and ensure `value` is defined
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

    return { selectedUTXOs, totalBTC, totalTOKEN };
}

// Broadcast the transaction to the Liquid network
async function broadcastTransaction(txHex: string): Promise<string> {
    const url = `${ESPLORA_API_URL}/tx`;

    const response = await fetch(url, {
        method: "POST",
        body: txHex,
    });

    const result = await response.text();

    console.log("Broadcast result:", result);

    return result;
}

function setStatus(status: string, append: boolean = false) {
    withdrawalStatus = status;
    setInnerHTML(
        "status",
        (append?"<br><br>":"") + status,
        append
    );
}