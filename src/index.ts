import zkp, { Secp256k1ZKP } from "@vulpemventures/secp256k1-zkp";
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
import log from "loglevel";
import * as ecclib from "tiny-secp256k1";

import { BitfinexWS } from "./bitfinex";
import { config, setConfig } from "./config";
import type { UTXO, WalletInfo } from "./consts/Types";
import "./style.css";
import {
    Counter,
    formatValue,
    fromSats,
    isTxid,
    reverseHex,
    scrambleArray,
    toSats,
} from "./utils";
import {
    decryptUTXOs,
    getBlindingKey,
    getPrivateKey,
    loadWasm,
    saveNewKeys,
} from "./wasm";

// wait 10 seconds to connect debugger
//await new Promise((f) => setTimeout(f, 10000));

// constants
const FEE_RESERVE = 100; // sats
const POLL_INTERVAL = 10_000; // frequency of mempool transaction polling, ms
const ERROR_MESSAGE = `
    <div style="text-align: center;">
        <h2>Error connecting to the exchange</h2>
        <p>We're experiencing issues loading the necessary information. Please try again later.</p>
    </div>`;

// Global variables
let network: networks.Network;
let exchangeRate: number | null = null;
let hasError = false;
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
let btcChangeAddress = "";
let tokenChangeAddress = "";
let lastSeenTxId = "";
let withdrawalStatus =
    "*** Keep this page open and do not refresh ***<br><br>Awaiting deposit...";
let interval: NodeJS.Timeout;
let assetIdMap: Map<string, string>;
let tradeMinBTC = 0; // denomitaned in sats
let tradeMinToken = 0; // denomitaned in sats
let tradeMaxBTC = 0; // denomitaned in sats
let tradeMaxToken = 0; // denomitaned in sats
let balanceBTC = 0; // denomitaned in sats
let balanceToken = 0; // denomitaned in sats

// fetched from a wallet API
let walletUTXOs: UTXO[] | null = null;
let depositKeys: UTXO | null = null;
let info: WalletInfo | null = null;

// Avoids top-level await
void (async () => {
    try {
        const response = await fetch("config.json");
        const data = await response.json();
        setConfig(data);

        switch (config.network) {
            case "mainnet":
                network = networks.liquid;
                break;
            case "testnet":
                network = networks.testnet;
                break;
            case "regtest":
                network = networks.regtest;
        }

        // Initialize the Bitfinex WebSocket with callback to update exchangeRate
        new BitfinexWS(config.bfxTicker, updateExchangeRate);

        // Get wallet info
        info = await getInfo();

        // assume what's reported to validate later
        balanceBTC = info.MaxSellBTC;
        balanceToken = info.MaxSellToken;
        tradeMinBTC = info.MinSellBTC;
        tradeMinToken = info.MinSellToken;

        // assume exchange rate from min values for quick estimate
        setTradeLimits(tradeMinToken / tradeMinBTC);

        // initiate WASM mobule
        loadWasm()
            .then(() => {
                log.info("WASM and Go runtime initialized");
                // Fetch UTXOs from API and load private keys into a Go WASM binary
                getUTXOs()
                    .then(() => {
                        if (!walletUTXOs) {
                            log.error("UTXOs are blank!");
                            balanceBTC = 0;
                            balanceToken = 0;
                            hasError = true;
                        } else {
                            validateReserves()
                                .then(() => {
                                    if (
                                        tradeMaxBTC < info.MaxSellBTC ||
                                        tradeMaxToken < info.MaxSellToken
                                    ) {
                                        // refresh screen with smallel limits
                                        renderPage();
                                    }
                                })
                                .catch((error) => {
                                    log.error(
                                        "Failed to validate reserves",
                                        error,
                                    );
                                    hasError = true;
                                });
                        }
                    })
                    .catch((error) => {
                        log.error("Failed to fetch UTXOs", error);
                        hasError = true;
                    });
            })
            .catch((error) => {
                log.error("Failed to initialize WASM and Go runtime", error);
                hasError = true;
            });

        // initialize asset lookup map
        if (!assetIdMap) {
            assetIdMap = new Map<string, string>([
                ["BTC", network.assetHash],
                [info.Token, info.TokenId],
            ]);
        }

        // Initialize blinder classes
        secp = await zkp();
        confi = new confidential.Confidential(secp);
        zkpValidator = new ZKPValidator(secp);
    } catch (error) {
        log.error("Failed to connect:", error);
        hasError = true;
    }

    const HTML_BODY = () => {
        return `
        <div class="btn btn-small">
            ${config.network}
        </div> 
        <div>
            <h1>Liquid ${config.titleTicker}</h1>   
            <h2>Non-custodial automatic exchange</h2> 
            <p>Send L-BTC (min ${formatValue(tradeMinBTC, "sats")}, max ${formatValue(tradeMaxBTC, "sats")} sats) to receive ${info.TokenName}</p>
            <p>Send ${info.TokenName} (min $${formatValue(tradeMinToken / 100_000_000, "USD")}, max $${formatValue(tradeMaxToken / 100_000_000, "USD")}) to receive L-BTC</p>
            <p>Exchange Rate: 1 BTC = <span id="rate">Loading...</span> ${info.Token}</p>
            <p>Fee Rate: ${formatValue(info.FeeRatePPM / 10_000, "")}% + ${info.FeeBaseSats} sats</p>
            <label for="return-address">Step 1. Paste your confidential withdrawal address:</label>
            <br><br>
            <div class="container">
                <input
                    class="input-box"
                    autocomplete="off"
                    type="text"
                    id="return-address"
                    placeholder="Blinded Liquid Address"
                    value="${withdrawalAddress}"
                />
            </div>
            <div id="step2" class="container" style="display:${withdrawalAddress ? "block" : "none"}">
                <p>Step 2. Fund this address with Liquid BTC or ${info.TokenName}:</p>
                <p id="depositAddress" class="copy-text"">${confDepositAddress ? confDepositAddress : " Deriving..."}</p>
                <p id="status">${withdrawalStatus}</p>
            </div>
            <br>
            <p>
                <small>
                    Commit Hash: 
                    <a
                        target="_blank"
                        href="${config.repoUrl}/commit/${__GIT_COMMIT__}">
                        ${__GIT_COMMIT__}
                    </a>
                </small>
            </p>
        </div>`;
    };

    renderPage();

    function copyToClipboard() {
        navigator.clipboard
            .writeText(confDepositAddress)
            .then(() => {
                const element = document.getElementById("depositAddress");
                if (element) {
                    element.textContent = confDepositAddress + " (copied)";
                }
            })
            .catch((err) => {
                alert("Failed to copy text: " + err);
            });
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

        const priceText = formatValue(exchangeRate, "USD");
        const element = document.getElementById("rate");
        if (element) {
            element.textContent = priceText;
        }

        // Update the document title with the mid-price
        document.title = `${priceText} ${config.titleTicker}`;
    }

    async function showDepositAddress() {
        if (confDepositAddress) {
            // show on the web page
            const element = document.getElementById("depositAddress");
            if (element) {
                element.textContent = confDepositAddress;

                // Attach the function to the element
                element.addEventListener("click", copyToClipboard);

                // Start polling for transactions
                interval = setInterval(pollForTransactions, POLL_INTERVAL);
            }
        } else {
            // fetch a new address, then show
            await getDepositAddress();
            await showDepositAddress();
        }
    }

    function renderPage() {
        // Remove loading
        document.body.classList.remove("loading");

        // Render page
        document.querySelector<HTMLDivElement>("#app")!.innerHTML = hasError
            ? ERROR_MESSAGE
            : HTML_BODY();

        // add listener to the input field
        if (!hasError) {
            const inputField = document.getElementById("return-address");
            const contentToToggle = document.getElementById("step2");

            // Function to toggle visibility based on input value
            async function toggleContentVisibility() {
                // verify address
                if (inputField) {
                    const addr = (inputField as HTMLInputElement).value;
                    if (addr) {
                        try {
                            if (address.isConfidential(addr)) {
                                contentToToggle.style.display = "block";
                                withdrawalAddress = addr;
                                await showDepositAddress();

                                // Generate return addresses for change
                                if (!btcChangeAddress) {
                                    btcChangeAddress =
                                        (await getNewAddress("BTC change")) ||
                                        confDepositAddress;
                                }

                                if (!tokenChangeAddress) {
                                    tokenChangeAddress =
                                        (await getNewAddress(
                                            `${info.Token} change`,
                                        )) || btcChangeAddress;
                                }

                                return;
                            }
                        } catch (error) {
                            log.error(error);
                        }
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
    }

    async function unblindUTXO(
        utxo: UTXO,
    ): Promise<confidential.UnblindOutputResult> {
        // get raw hex
        let response = await fetch(
            `${config.blockExplorerUrl}/api/tx/${utxo.TxId}/hex`,
        );
        const txHex = await response.text();

        // Process the transaction details
        const tx = Transaction.fromHex(txHex);
        const unblindedOutput = confi.unblindOutputWithKey(
            tx.outs[utxo.Vout],
            Buffer.from(getBlindingKey(utxo.N), "base64"),
        );
        // add witness
        utxo.witness = tx.outs[utxo.Vout];

        // check for spent outputs
        response = await fetch(
            `${config.blockExplorerUrl}/api/tx/${utxo.TxId}/outspends`,
        );

        const isSpent = await response.json();

        if (isSpent[utxo.Vout].spent!) {
            unblindedOutput.value = "0";
        }

        return unblindedOutput;
    }

    async function fetchValue(utxo: UTXO) {
        const unblindedOutput = await unblindUTXO(utxo);
        const assetId = AssetHash.fromBytes(unblindedOutput.asset).hex;
        let token = "unknown";
        let value = 0;

        // map the asset id to token ticker
        for (const key of assetIdMap.keys()) {
            if (assetIdMap.get(key) == assetId) {
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
            // pass
            return;
        }

        try {
            const response = await fetch(
                `${config.blockExplorerUrl}/api/address/${confDepositAddress}/txs`,
            );
            const transactions = await response.json();

            if (transactions.length > 0) {
                const depositTx = transactions[0];

                if (depositTx.status.confirmed) {
                    if (lastSeenTxId === depositTx.txid) {
                        return;
                    }

                    lastSeenTxId = depositTx.txid;
                    withdrawalPending = true;

                    // find output number
                    let vout = 0;
                    for (const output of depositTx.vout) {
                        if (
                            output.scriptpubkey_address === explDepositAddress
                        ) {
                            break;
                        }
                        vout++;
                    }

                    // fetch value and token and append new UTXO to wallet
                    const deposit = await appendDeposit(depositTx.txid, vout);

                    if (
                        (deposit.token === "BTC" &&
                            deposit.value >= tradeMinBTC) ||
                        (deposit.token === info.Token &&
                            deposit.value >= tradeMinToken)
                    ) {
                        const senderAddress =
                            depositTx.vin[0].prevout.scriptpubkey_address;
                        const formattedValue = formatValue(
                            fromSats(deposit.value),
                            deposit.token,
                        );

                        setStatus(
                            `Received ${formattedValue} ${deposit.token} from ${senderAddress}`,
                        );

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
                            setStatus(
                                `Please provide confidential withdrawal address!`,
                            );

                            withdrawalPending = false;
                            return;
                        }

                        // amounts to be sent back
                        let withdrawBTC = 0; // in sats
                        let withdrawToken = 0; // in sats

                        if (!exchangeRate) {
                            // Exception: exchangeRate not set
                            setStatus(
                                `ERROR! Exchange rate is not available, preceeding with refund.`,
                                true,
                            );
                            if (deposit.token === "BTC") {
                                withdrawBTC = deposit.value;
                            } else {
                                withdrawToken = deposit.value;
                            }
                        } else {
                            // Fix rate and compute withdrawal
                            const fixedRate = exchangeRate;

                            // assume we sold BTC
                            let feeDirection = "+";
                            let bumpedRate = Math.round(
                                exchangeRate *
                                    (1 + info.FeeRatePPM / 1_000_000),
                            );
                            withdrawBTC =
                                Math.floor(deposit.value / bumpedRate) -
                                info.FeeBaseSats;
                            withdrawToken = 0;

                            if (deposit.token == "BTC") {
                                // we actually bough BTC
                                feeDirection = "-";
                                bumpedRate = Math.round(
                                    exchangeRate *
                                        (1 - info.FeeRatePPM / 1_000_000),
                                );
                                withdrawToken = Math.floor(
                                    (deposit.value - info.FeeBaseSats) *
                                        bumpedRate,
                                );
                                withdrawBTC = 0;
                            }

                            setStatus(
                                `Exchange rate fixed at ${formatValue(fixedRate, "USD")} ${feeDirection} ${formatValue(info.FeeRatePPM / 10_000, "")}% = ${formatValue(bumpedRate, "USD")}`,
                                true,
                            );

                            // verify limits
                            const withdrawMaxToken = balanceToken;
                            const withdrawMaxBTC = tradeMaxToken / fixedRate;

                            if (withdrawToken > withdrawMaxToken) {
                                // wants to withdraw too much Token, refund some BTC
                                withdrawBTC = Math.min(
                                    balanceBTC - FEE_RESERVE,
                                    Math.floor(
                                        (withdrawToken - withdrawMaxToken) /
                                            bumpedRate,
                                    ),
                                );
                                withdrawToken = withdrawMaxToken;
                                setStatus(
                                    `Trade is over limit. Withdrawal will include partial refund of BTC...`,
                                    true,
                                );
                            }

                            if (withdrawBTC > withdrawMaxBTC) {
                                // wants to withdraw too much BTC, refund some TOKEN
                                withdrawToken = Math.min(
                                    balanceToken,
                                    Math.floor(
                                        (withdrawBTC - withdrawMaxBTC) *
                                            bumpedRate,
                                    ),
                                );
                                withdrawBTC = withdrawMaxBTC;
                                setStatus(
                                    `Trade is over limit. Withdrawal will include partial refund of ${info.TokenName}...`,
                                    true,
                                );
                            }
                        }

                        let textAmount = "";

                        if (withdrawToken > 0) {
                            textAmount =
                                formatValue(fromSats(withdrawToken), "USD") +
                                " " +
                                info.TokenName;
                        }

                        if (withdrawBTC > 0) {
                            const t =
                                formatValue(fromSats(withdrawBTC), "BTC") +
                                " BTC";
                            if (textAmount) {
                                textAmount += " + " + t;
                            } else {
                                textAmount = t;
                            }
                        }

                        setStatus(
                            `Sending ${textAmount} to ${address.fromConfidential(withdrawalAddress).unconfidentialAddress}`,
                            true,
                        );

                        const success = await processWithdrawal(
                            withdrawalAddress,
                            withdrawBTC,
                            withdrawToken,
                        );

                        if (success) {
                            withdrawalComplete = true;
                            clearInterval(interval);
                        } else {
                            // refresh wallet UTXOs to try again
                            setStatus(`Refreshing wallet balances...`, true);
                            //await getUTXOs();
                            await validateReserves();
                            // try again
                            lastSeenTxId = "";
                        }
                    } else {
                        // ignore the deposit
                        let dustStatus: string;
                        if (deposit.token === info.Token) {
                            dustStatus = `Dust deposit of $${formatValue(deposit.value / 100_000_000, "USD")}`;
                        } else if (deposit.token === "BTC") {
                            dustStatus = `Dust deposit of ${formatValue(deposit.value, "sats")} sats`;
                        } else {
                            dustStatus = `Deposit of unknown token`;
                        }
                        setStatus(
                            `${dustStatus} ignored. Awaiting new deposit...`,
                        );
                    }
                } else {
                    setStatus(
                        `Deposit is in mempool, awaiting confirmation...`,
                    );
                }
            }
        } catch (error) {
            log.error("Error:", error);
        }

        withdrawalPending = false;
    }

    // Process the withdrawal
    async function processWithdrawal(
        toAddress: string,
        satsBTC: number,
        satsToken: number,
    ): Promise<boolean> {
        let satsFee = info.FeeBaseSats;
        let tx: Transaction;

        // try a maximum of 10 times to optimize the fee
        for (let i = 0; i < 10; i++) {
            // Create the withdrawal Transaction
            tx = await prepareTransaction(
                toAddress,
                satsBTC,
                satsToken,
                satsFee,
                btcChangeAddress,
                tokenChangeAddress,
            );

            if (!tx) {
                return false;
            }

            const vSize = tx.virtualSize(true);
            const optimalFee = Math.ceil(vSize / 10);

            if (satsFee == optimalFee || (i > 2 && satsFee > optimalFee)) {
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
                log.error("Failed to unblind output:", error);
            }

            setStatus(
                `Withdrawal TxId: <a href="${config.blockExplorerUrl}/tx/${result}${blinded}" target="_blank">${result}</a>`,
                true,
            );

            setStatus(`Refresh the page to do another swap`, true);

            return true;
        } else {
            setStatus(`Error: ${result}`, true);
            return false;
        }
    }

    // Create the transaction
    async function prepareTransaction(
        toAddress: string, // withdrawal address
        satsBTC: number,
        satsToken: number,
        satsFee: number,
        btcChangeAddress: string,
        tokenChangeAddress: string,
    ): Promise<Transaction | null> {
        const pset = Creator.newPset();
        const ins: UpdaterInput[] = [];
        let outs: UpdaterOutput[] = [];

        // Select UTXOs
        const { selectedUTXOs, totalBTC, totalToken } = selectUTXOs(
            satsBTC,
            satsToken,
            satsFee,
        );

        log.debug("Selected UTXOs:", selectedUTXOs);

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
        const counter = new Counter(numBlinders);

        if (totalToken > 0) {
            const changeToken = totalToken - satsToken;

            if (changeToken > config.dustToken) {
                // Add the TOKEN change output
                outs.push({
                    asset: assetIdMap.get(info.Token)!,
                    amount: changeToken,
                    script: address.toOutputScript(tokenChangeAddress, network),
                    blinderIndex: counter.iterate(),
                    blindingPublicKey:
                        address.fromConfidential(tokenChangeAddress)
                            .blindingKey,
                });
            } else {
                // donate to client
                satsToken += changeToken;
            }

            if (satsToken > 0) {
                // add TOKEN output
                outs.push({
                    asset: assetIdMap.get(info.Token)!,
                    amount: satsToken,
                    script: address.toOutputScript(toAddress, network),
                    blinderIndex: counter.iterate(),
                    blindingPublicKey:
                        address.fromConfidential(toAddress).blindingKey,
                });
            }
        }

        const changeBTC = totalBTC - satsBTC - satsFee;
        if (changeBTC > config.dustBTC) {
            // Add the change output in BTC
            outs.push({
                asset: assetIdMap.get("BTC")!,
                amount: changeBTC,
                script: address.toOutputScript(btcChangeAddress, network),
                blinderIndex: counter.iterate(),
                blindingPublicKey:
                    address.fromConfidential(btcChangeAddress).blindingKey,
            });
        } else {
            // add dust change to the client amount
            satsBTC += changeBTC;
        }

        if (satsBTC > 0) {
            // add BTC output to client
            outs.push({
                asset: assetIdMap.get("BTC")!,
                amount: satsBTC,
                script: address.toOutputScript(toAddress, network),
                blinderIndex: counter.iterate(),
                blindingPublicKey:
                    address.fromConfidential(toAddress).blindingKey,
            });
        }

        // improve privacy by scrambling outputs
        outs = scrambleArray(outs);

        // Add the fee output
        outs.push({
            asset: assetIdMap.get("BTC")!,
            amount: satsFee,
        });

        // build the tx
        const updater = new Updater(pset);
        updater.addInputs(ins).addOutputs(outs);

        log.debug("PSET before blinding:", pset);

        // Enumerate owned inputs
        const ownedInputs: OwnedInput[] = [];

        for (let i = 0; i < numBlinders; i++) {
            const unblindedOutput = await unblindUTXO(selectedUTXOs[i]);

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
        const blinder = new Blinder(
            pset,
            ownedInputs,
            zkpValidator,
            zkpGenerator,
        );
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

            // find the index of the output that pays to the client
            for (const [index, output] of outs.entries()) {
                if (toHexString(output.script) === toHexString(script)) {
                    mainOutput = index;
                    break;
                }
            }

            // find the nonce of the client output
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

            // Generate the ECDSA signature for the input using your ECC library
            const signature = ecclib.sign(
                new Uint8Array(preimage),
                new Uint8Array(
                    Buffer.from(
                        getPrivateKey(selectedUTXOs[index].N),
                        "base64",
                    ),
                ),
            );

            // Attach signature to the input as a partial signature
            const partialSig = {
                pubkey: Buffer.from(selectedUTXOs[index].PubKey, "base64"),
                signature: script.signature.encode(
                    Buffer.from(signature),
                    sighash,
                ),
            };

            pset.inputs[index].partialSigs =
                pset.inputs[index].partialSigs || [];
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

    // Broadcast the transaction to the Liquid network
    async function broadcastTransaction(txHex: string): Promise<string> {
        const url = `${config.blockExplorerUrl}/api/tx`;

        log.debug("Broadcasting HEX:", txHex);

        const response = await fetch(url, {
            method: "POST",
            body: txHex,
        });

        const result = await response.text();

        log.info("Broadcast result:", result);

        return result;
    }

    async function validateReserves() {
        let balBTC = 0;
        let balToken = 0;

        for (let i = 0; i < walletUTXOs.length; i++) {
            await fetchValue(walletUTXOs[i]);
            if (walletUTXOs[i].value > 0) {
                if (walletUTXOs[i].token == "BTC") {
                    balBTC += walletUTXOs[i].value;
                } else {
                    balToken += walletUTXOs[i].value;
                }
            }
        }

        balanceBTC = balBTC;
        balanceToken = balToken;

        log.info("Validated reserves");

        while (!exchangeRate) {
            log.warn("No Bitfinex price feed, wait 5 seconds.");
            // wait for price feed
            await new Promise((f) => setTimeout(f, 5000));
        }

        setTradeLimits(exchangeRate);
    }

    function setTradeLimits(exchangeRate: number) {
        tradeMaxBTC =
            // round down to 1000 sats
            Math.floor(
                Math.min(info.MaxSellToken, balanceToken) / exchangeRate / 1000,
            ) * 1000;

        tradeMaxToken =
            // round down to $100
            toSats(
                Math.floor(
                    fromSats(
                        Math.min(info.MaxSellBTC, balanceBTC) * exchangeRate,
                    ) / 100,
                ) * 100,
            );
    }

    // fetch wallet private and blinding keys for UTXOs
    async function getUTXOs() {
        try {
            const response = await fetch(`${config.apiUrl}/utxos`, {
                signal: AbortSignal.timeout(20000),
            });
            if (!response.ok) {
                log.error("Failed to fetch UTXOs");
                throw new Error(
                    `Failed to fetch UTXOs: ${response.statusText}`,
                );
            }
            const base64data = await response.text();
            walletUTXOs = decryptUTXOs(base64data, "wallet");
            log.info("Fetched UTXOs and keys");
        } catch (error) {
            log.error("Error fetching UTXOs:", error);
            throw error;
        }
    }

    // fetch private and blinding keys for a new address
    async function getNewKeys(label: string): Promise<UTXO | null> {
        try {
            const response = await fetch(`${config.apiUrl}/keys?l=${label}`, {
                signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) {
                log.error("Error fetching new keys:", response.statusText);
                return null;
            }
            const base64data = await response.text();
            return decryptUTXOs(base64data, "new")[0];
        } catch (error) {
            log.error("Error fetching new keys:", error);
            return null;
        }
    }

    // Fetch private and blinding keys, then generate the deposit address
    // This ensures that the client gets the refund if funding exceeds limit
    async function getDepositAddress() {
        depositKeys = await getNewKeys("deposit");
        if (!depositKeys) {
            hasError = true;
            renderPage();
        }
        const blindingPublicKey = Buffer.from(depositKeys.PubBlind, "base64");
        const publicKey = Buffer.from(depositKeys.PubKey, "base64");

        // Generate explicit address using P2WPKH
        explDepositAddress = payments.p2wpkh({
            pubkey: publicKey,
            network: network,
        }).address!;

        // Convert to confidential
        confDepositAddress = address.toConfidential(
            explDepositAddress,
            blindingPublicKey,
        );
    }

    // returns a new bech32m address
    async function getNewAddress(label: string): Promise<string | null> {
        try {
            const response = await fetch(
                `${config.apiUrl}/address?l=${label}`,
                {
                    signal: AbortSignal.timeout(3000),
                },
            );
            if (!response.ok) {
                log.error("Failed getting new address");
                return null;
            }
            return await response.text();
        } catch (error) {
            log.error("Error getting new address:", error);
            return null;
        }
    }

    // append deposit UTXO to walletUTXOs
    async function appendDeposit(
        txid: string,
        vout: number,
    ): Promise<{ token: string; value: number }> {
        let token = "unknown";
        let value = 0;

        if (walletUTXOs[walletUTXOs.length - 1].TxId != txid) {
            // append to walletUTXOs
            depositKeys.TxId = txid;
            depositKeys.Vout = vout;
            depositKeys.N = walletUTXOs.length;

            // append in go wallet
            saveNewKeys();

            // get token and value
            await fetchValue(depositKeys);

            // append in js wallet
            walletUTXOs.push(depositKeys);

            token = depositKeys.token;
            value = depositKeys.value;

            // increase balance
            if (token === info.Token) {
                balanceToken += value;
            } else if (token === "BTC") {
                balanceBTC += value;
            }
        }

        return { token, value };
    }

    // 1. Always spend the new deposit UTXO to signal success
    // 2. Prioritise smallest UTXOs to consolidate them
    function selectUTXOs(
        satsBTC: number,
        satsToken: number,
        satsFee: number,
    ): { selectedUTXOs: UTXO[]; totalBTC: number; totalToken: number } {
        let totalBTC = 0;
        let totalToken = 0;
        const selectedUTXOs: UTXO[] = [];
        let leftToAllocate = satsToken;
        const lastN = walletUTXOs.length - 1;

        // add the newly deposited UTXO first
        selectedUTXOs.push(walletUTXOs[lastN]);

        // account for the first selected UTXO
        if (walletUTXOs[lastN].token! === info.Token) {
            leftToAllocate -= walletUTXOs[lastN].value!;
            totalToken += walletUTXOs[lastN].value!;
        }

        // sort BTC by increasing value, exclude the last one
        let btcUTXOs = walletUTXOs
            .filter(
                (utxo) =>
                    utxo.token! === "BTC" && utxo.value! > 0 && utxo.N! < lastN,
            )
            .sort((a, b) => (a.value || 0) - (b.value || 0)); // Sort by `value` ascending

        // check if need to transfer Token
        if (satsToken > 0) {
            const tokenUTXOs = walletUTXOs
                .filter(
                    (utxo) =>
                        utxo.token! === info.Token &&
                        utxo.value! > 0 &&
                        utxo.N! < lastN,
                )
                .sort((a, b) => (a.value || 0) - (b.value || 0)); // Sort by `value` ascending

            for (const utxo of tokenUTXOs) {
                if (leftToAllocate <= 0) {
                    break;
                }
                selectedUTXOs.push(utxo);
                leftToAllocate -= utxo.value!;
                totalToken += utxo.value!;
            }

            // re-sort to use the largest BTC UTXO to pay the network fee
            btcUTXOs = walletUTXOs
                .filter(
                    (utxo) =>
                        utxo.token! === "BTC" &&
                        utxo.value! > 0 &&
                        utxo.N! < lastN,
                ) // Filter by token and ensure `value` is defined
                .sort((a, b) => (b.value || 0) - (a.value || 0)); // Sort by `value` descending
        }

        leftToAllocate = satsBTC + satsFee;

        // account for the first selected UTXO
        if (walletUTXOs[lastN].token! === "BTC") {
            leftToAllocate -= walletUTXOs[lastN].value!;
            totalBTC += walletUTXOs[lastN].value!;
        }

        for (const utxo of btcUTXOs) {
            if (leftToAllocate <= 0) {
                break;
            }
            selectedUTXOs.push(utxo);
            leftToAllocate -= utxo.value!;
            totalBTC += utxo.value!;
        }
        return { selectedUTXOs, totalBTC, totalToken };
    }

    // fetch wallet info, including private and blinding keys for UTXOs
    async function getInfo(): Promise<WalletInfo> {
        try {
            const response = await fetch(`${config.apiUrl}/info`, {
                signal: AbortSignal.timeout(3000),
            });
            if (!response.ok) {
                log.error("Failed to fetch Info");
                throw new Error(`Failed to fetch Info: ${response.statusText}`);
            }
            // Type assertion to specify that response.json() should return a WalletInfo
            const walletInfo: WalletInfo =
                (await response.json()) as WalletInfo;
            return walletInfo;
        } catch (error) {
            log.error("Error fetching Info:", error);
            throw error;
        }
    }

    function setStatus(status: string, append: boolean = false) {
        if (append) {
            withdrawalStatus += "<br><br>" + status;
        } else {
            withdrawalStatus = status;
        }
        renderPage();
    }
})();
