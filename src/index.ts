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

import { BitfinexWS } from "./bitfinex";
import { config, setConfig } from "./config";
import type { UTXO, WalletInfo } from "./consts/Types";
import "./style.css";
import {
    Counter,
    formatValue,
    fromSats,
    getUrlParam,
    isTxid,
    reverseHex,
    scrambleArray,
    toSats,
    urlParamIsSet,
} from "./utils";
import {
    decryptAddresses,
    decryptUTXOs,
    encryptRequest,
    getBlindingKey,
    loadWasm,
    saveNewKeys,
    signPreimage,
} from "./wasm";

// wait 10 seconds to connect debugger
//await new Promise((f) => setTimeout(f, 10000));

// constants
const API_TIMEOUT = 30_000; // 30 seconds max for wallet API fetching
const FEE_RESERVE = 100; // sats
const POLL_INTERVAL = 5_000; // frequency of mempool transaction polling, ms

// Global variables
let network: networks.Network;
let exchangeRate: number | null = null;
let exchangeRateText = "Connecting...";
let hasError = false;
let displayError =
    "We're experiencing issues loading the necessary information. Please try again later.";
let withdrawalPending: boolean = false;
let withdrawalComplete: boolean = false;
let broadcastAttempts = 0;
let confi: confidential.Confidential;
let secp: Secp256k1ZKP;
let zkpValidator: ZKPValidator;
let mainOutput = 0; // used to show the unblinded tx in explorer
let mainNonce: Buffer; // used to show the unblinded tx in explorer
let confDepositAddress = "";
let explDepositAddress = "";
let confWithdrawalAddress = "";
let explWithdrawalAddress = "";
let btcChangeAddress = "";
let tokenChangeAddress = "";
let lastSeenTxId = "";
let statusText = "Validating wallet balances, please wait...";
let limitsValidated = false;
let interval: NodeJS.Timeout;
let assetIdMap: Map<string, string>;
let tradeMinBTC = 0; // denomitaned in sats
let tradeMinToken = 0; // denomitaned in sats
let tradeMaxBTC = 0; // denomitaned in sats
let tradeMaxToken = 0; // denomitaned in sats
let balanceBTC = 0; // denomitaned in sats
let balanceToken = 0; // denomitaned in sats
let resumeLink = "";
let ws: BitfinexWS;

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

        log.debug("Network:", config.network);

        // Get wallet info
        getInfo()
            .then((i) => {
                info = i;
                log.info("Fetched wallet info");

                // Initialize Bitfinex WebSocket with callback to update exchangeRate
                ws = new BitfinexWS(info.Ticker, updateExchangeRate);

                // initialize asset lookup map
                if (!assetIdMap) {
                    assetIdMap = new Map<string, string>([
                        ["BTC", network.assetHash],
                        [info.Token, info.TokenId],
                    ]);
                }

                // assume exchange rate from min values for quick estimate
                const assumedFX = info.MinBuyToken / info.MinBuyBTC;
                balanceBTC = info.MaxBuyToken / assumedFX;
                balanceToken = info.MaxBuyBTC * assumedFX;
                tradeMinBTC = info.MinBuyBTC;
                // round to $1
                tradeMinToken = toSats(Math.round(fromSats(info.MinBuyToken)));
                setTradeLimits(assumedFX);

                const withdrawalAddr = getUrlParam("w");
                if (urlParamIsSet(withdrawalAddr)) {
                    if (setWithdrawalAddress(withdrawalAddr)) {
                        log.info("Withdrawal address provided in URL");
                    } else {
                        log.warn("Invalid withdrawal address provided");
                    }
                }
            })
            .catch((error) => {
                log.error("Failed to load wallet info", error);
                hasError = true;
                ws.disconnect();
            })
            .finally(() => renderPage());

        // initiate WASM mobule
        loadWasm()
            .then(() => {
                log.info("WASM and Go runtime initialized");

                // Fetch UTXOs from API and load private keys into the Go WASM binary
                getUTXOs()
                    .then(() => {
                        if (!walletUTXOs) {
                            log.error("UTXOs are blank!");
                            balanceBTC = 0;
                            balanceToken = 0;
                            hasError = true;
                        } else {
                            // verify wallet balances
                            validateReserves()
                                .then(() => {
                                    limitsValidated = true;
                                    statusText = `<small>This exchange is running entirely in your browser and has loaded all the data necessary for autonomous operation. Read <a title="Click to read about the app" target="_blank" href="${config.repoUrl}/blob/main/README.md">FAQ</a>`;
                                    if (config.network == "mainnet") {
                                        statusText += ` or try it on <a target="_blank" href="${config.testnetUrl}">Liquid Testnet</a>`;
                                    }
                                    statusText += `.</small>`;

                                    const depositAddr = getUrlParam("d");
                                    if (urlParamIsSet(depositAddr)) {
                                        getAddresses(depositAddr)
                                            .then(() => {
                                                showDepositAddress().catch(
                                                    (error) => {
                                                        displayError =
                                                            "Failed to resume swap: " +
                                                            error;
                                                        hasError = true;
                                                        ws.disconnect();
                                                    },
                                                );
                                            })
                                            .catch((error) => {
                                                displayError =
                                                    "Failed to resume swap: " +
                                                    error;
                                                hasError = true;
                                                ws.disconnect();
                                            });
                                    } else if (confWithdrawalAddress) {
                                        displayError =
                                            "Resume link is incomplete!";
                                        hasError = true;
                                        ws.disconnect();
                                    }
                                })
                                .catch((error) => {
                                    displayError = `Failed to validate reserves: ${error}`;
                                    hasError = true;
                                    ws.disconnect();
                                })
                                .finally(() => renderPage());
                        }
                    })
                    .catch((error) => {
                        log.error("Failed to fetch UTXOs", error);
                        hasError = true;
                        ws.disconnect();
                    });
            })
            .catch((error) => {
                log.error("Failed to initialize WASM and Go runtime", error);
                hasError = true;
                ws.disconnect();
            });

        // Initialize blinder classes
        zkp()
            .then((s) => {
                secp = s;
                confi = new confidential.Confidential(secp);
                zkpValidator = new ZKPValidator(secp);
            })
            .catch((error) => {
                log.error("Failed to initialize zkp", error);
                hasError = true;
                ws.disconnect();
            });
    } catch (error) {
        log.error("Failed to connect:", error);
        hasError = true;
        ws.disconnect();
    }

    const ERROR_MESSAGE = () => {
        let t = `<div style="text-align: center;">
            <h2>Connection Lost!</h2>
            <p>${displayError}</p>`;
        if (resumeLink) {
            t += `If you have already sent the deposit, DO NOT reload this page or your funds WILL BE LOST.<br><br>Save <a href="${resumeLink}">this link</a> to resume the swap when you are back online.`;
        }
        t += `</div>`;
        return t;
    };

    const HTML_BODY = () => {
        let htmlText = "";

        if (config.network != "mainnet") {
            htmlText += `<div class="btn btn-small">
                ${config.network}
            </div>`;
        }

        htmlText += `
        <div>
            <h1>Liquid BTC/${info.Token}</h1>   
            <h3>Non-Custodial Automatic Exchange</h3> 
            <p>Send L-BTC (min ${formatValue(tradeMinBTC, "sats")}, max ${formatValue(tradeMaxBTC, "sats")} sats) to receive ${info.TokenName}</p>
            <p>Send ${info.TokenName} (min $${formatValue(tradeMinToken / 100_000_000, "USD")}, max $${formatValue(tradeMaxToken / 100_000_000, "USD")}) to receive L-BTC</p>
            <h2 id="rate">${exchangeRateText}</h2>
            <p>Fee: ${info.FeeRatePPM / 10_000}% + ${info.FeeBaseSats} sats</p>
            <div class="container" style="display:${confWithdrawalAddress || !limitsValidated ? "none" : "block"}">
                <label for="return-address">Step 1/2. Paste your confidential withdrawal address:</label>
                <br><br>
                <input
                    class="input-box"
                    autocomplete="off"
                    type="text"
                    id="return-address"withdrawalStatus
                    placeholder="Use p2wpkh address for better privacy"
                    value=""
                />
            </div>
            <div class="container" style="display:${confWithdrawalAddress && !withdrawalComplete ? "block" : "none"}">
                <p>Withdrawal address: ${confWithdrawalAddress} (confidential) / ${explWithdrawalAddress} (explicit)</p>
                <p>Step 2/2. Deposit Liquid BTC or ${info.TokenName} to this address (click to copy):</p>
                <p id="depositAddress" class="copy-text">${confDepositAddress ? confDepositAddress : " Deriving..."}</p>
            </div>
            <div class="container">
                <p id="status">${statusText}</p>
            </div>
            <p>
                <small>
                    Commit:
                    <a
                        target="_blank"
                        href="${config.repoUrl}/commit/${__GIT_COMMIT__}">
                        ${__GIT_COMMIT__} dated ${__GIT_DATE__}
                    </a>
                </small>
            </p>
        </div>`;

        return htmlText;
    };

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
        const wasError = hasError;

        hasError = !price;

        if (wasError != hasError) {
            // changed error status
            renderPage();
        }

        if (!hasError) {
            exchangeRate = price;
            exchangeRateText = `${formatValue(exchangeRate, "sats")} BTC/${info.Token}`;
            const element = document.getElementById("rate");
            if (element) {
                element.textContent = exchangeRateText;
            }

            // Update the document title with the mid-price
            document.title = exchangeRateText;
        }
    }

    function setWithdrawalAddress(addr: string): boolean {
        try {
            if (address.decodeType(addr, network) > 3) {
                confWithdrawalAddress = addr;
                explWithdrawalAddress = address.fromConfidential(
                    confWithdrawalAddress,
                ).unconfidentialAddress;
                return true;
            }
        } catch (error) {
            log.error(error);
            setStatus(`Confidential ${config.network} address expected`);
        }
        return false;
    }

    async function showDepositAddress() {
        if (confDepositAddress) {
            // redraw web page
            renderPage();
            setStatus("");
        } else {
            // fetch a new addresses, then show
            setStatus("Fetching deposit address...");
            await getAddresses();
            await showDepositAddress();
        }
    }

    function renderPage() {
        // Remove loading
        document.body.classList.remove("loading");

        // Render page
        document.querySelector<HTMLDivElement>("#app")!.innerHTML = hasError
            ? ERROR_MESSAGE()
            : HTML_BODY();

        if (!hasError) {
            setTimeout(() => {
                // add listener to the input field
                const inputField = document.getElementById("return-address");

                // Function to toggle visibility based on input value
                async function toggleContentVisibility() {
                    // verify address
                    if (inputField) {
                        const addr = (inputField as HTMLInputElement).value;
                        if (addr) {
                            if (setWithdrawalAddress(addr)) {
                                await showDepositAddress();
                                return;
                            } else {
                                setStatus(
                                    `Confidential ${config.network} address expected`,
                                );
                            }
                            return;
                        }
                    }
                }

                if (inputField) {
                    // Add event listener for paste event
                    inputField.addEventListener("paste", () => {
                        setTimeout(toggleContentVisibility, 0); // Delay to ensure the pasted content is read
                    });
                }

                if (confDepositAddress && !withdrawalComplete) {
                    // add listener to depositAddress link
                    const element = document.getElementById("depositAddress");
                    if (element) {
                        // Attach the function to the element
                        element.addEventListener("click", copyToClipboard);

                        setStatus(
                            "Keep this page open and do not refresh! Awaiting deposit...",
                        );

                        if (!interval) {
                            // Start polling for transactions
                            interval = setInterval(
                                pollForTransactions,
                                POLL_INTERVAL,
                            );
                        }
                    }
                }
            }, 0);
        }
    }

    async function unblindUTXO(
        utxo: UTXO,
    ): Promise<confidential.UnblindOutputResult> {
        // get raw hex
        const response = await fetch(
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
        return unblindedOutput;
    }

    // gets unblinded and unspent value of the UTXO
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

        // check for spent output
        const response = await fetch(
            `${config.blockExplorerUrl}/api/tx/${utxo.TxId}/outspend/${utxo.Vout}`,
        );

        const isSpent = await response.json();

        if (isSpent.spent!) {
            value = 0;
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
                // Look at the latest tx only
                const depositTx = transactions[0];

                // find output number
                let vout = 0;
                for (const output of depositTx.vout) {
                    if (output.scriptpubkey_address === explDepositAddress) {
                        break;
                    }
                    vout++;
                }

                if (vout === depositTx.vout.length) {
                    throw "The latest transaction does not fund the deposit address";
                }

                // check for spent outputs
                const response = await fetch(
                    `${config.blockExplorerUrl}/api/tx/${depositTx.txid}/outspend/${vout}`,
                );

                const isSpent = await response.json();
                if (isSpent.spent!) {
                    throw "Deposit has been spent";
                }

                if (depositTx.status.confirmed) {
                    if (lastSeenTxId === depositTx.txid) {
                        return;
                    }

                    lastSeenTxId = depositTx.txid;
                    withdrawalPending = true;

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
                                `Exchange rate fixed at ${formatValue(fixedRate, "sats")} ${feeDirection} ${info.FeeRatePPM / 10_000}% = ${formatValue(bumpedRate, "sats")}`,
                                true,
                            );

                            // verify limits
                            const withdrawMaxToken = tradeMaxBTC * bumpedRate;
                            const withdrawMaxBTC = tradeMaxToken / bumpedRate;

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
                                    `Deposit exceeds max limit. Withdrawal will include partial refund of BTC.`,
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
                                    `Deposit exceeds max limit. Withdrawal will include partial refund of ${info.TokenName}.`,
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
                            `Sending ${textAmount} to ${explWithdrawalAddress}`,
                            true,
                        );

                        const success = await processWithdrawal(
                            confWithdrawalAddress,
                            withdrawBTC,
                            withdrawToken,
                        );

                        if (success) {
                            withdrawalComplete = true;
                            clearInterval(interval);
                            resumeLink = "";
                            renderPage();
                        } else {
                            broadcastAttempts++;
                            if (broadcastAttempts < 3) {
                                // recalculate wallet balance to try again
                                setStatus(
                                    `Refreshing wallet balances...`,
                                    true,
                                );
                                await validateReserves();
                                // try again
                                lastSeenTxId = "";
                            } else {
                                // stop trying after 3 failures
                                clearInterval(interval);
                            }
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
                btcChangeAddress || confDepositAddress,
                tokenChangeAddress || confDepositAddress,
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
                `Result: <a href="${config.blockExplorerUrl}/tx/${result}${blinded}" target="_blank">Success!</a>`,
                true,
            );

            setStatus(`Reload this page for another swap`, true);

            return true;
        } else {
            setStatus(`Error: ${result}<br><br>Tx hex: ${txHex}`, true);
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

        if (satsBTC > totalBTC - satsFee) {
            satsBTC = totalBTC - satsFee;
            log.warn(
                `Only ${fromSats(totalBTC)} BTC available to pay ${fromSats(satsBTC)} withdrawal with ${satsFee} sats fee`,
            );
        }

        if (satsToken > totalToken) {
            satsToken = totalToken;
            log.warn(
                `Only ${fromSats(totalToken)} ${info.TokenName} available for withdrawal`,
            );
        }

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
            const signature = signPreimage(preimage, selectedUTXOs[index].N);

            // Attach signature to the input as a partial signature
            const partialSig = {
                pubkey: Buffer.from(selectedUTXOs[index].PubKey, "base64"),
                signature: script.signature.encode(signature, sighash),
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
            // this validates .value in each UTXO
            await fetchValue(walletUTXOs[i]);
            if (walletUTXOs[i].value > 0) {
                if (walletUTXOs[i].token == "BTC") {
                    balBTC += walletUTXOs[i].value;
                } else if (walletUTXOs[i].token == info.Token) {
                    balToken += walletUTXOs[i].value;
                }
            }
        }

        balanceBTC = balBTC;
        balanceToken = balToken;

        log.info("Wallet reserves validated");

        while (!exchangeRate) {
            // wait for price feed
            await new Promise((f) => setTimeout(f, 2000));
            if (!exchangeRate) {
                log.warn("No Bitfinex price feed, wait 2 seconds.");
            }
        }

        setTradeLimits(exchangeRate);
    }

    function setTradeLimits(exchangeRate: number) {
        tradeMaxBTC =
            // floor to 1000 sats
            Math.floor(
                Math.min(info.MaxBuyBTC, balanceToken / exchangeRate) / 1000,
            ) * 1000;

        tradeMaxToken =
            // floor to $1
            toSats(
                Math.floor(
                    fromSats(
                        Math.min(
                            info.MaxBuyToken,
                            (balanceBTC - FEE_RESERVE) * exchangeRate,
                        ),
                    ),
                ),
            );
    }

    // fetch wallet private and blinding keys for UTXOs
    async function getUTXOs() {
        try {
            const base64data = await fetchEncrypted("utxos");
            walletUTXOs = decryptUTXOs(base64data);
            if (!walletUTXOs) {
                throw "Error fetching UTXOs";
            }
            log.info("Fetched UTXOs and keys");
        } catch (error) {
            log.error("Error fetching UTXOs:", error);
            throw error;
        }
    }

    // Fetch new private and blinding keys, then generate the deposit address
    // This ensures that the client gets the refund if funding exceeds limit
    // The same request also fetches two change addresses
    async function getAddresses(base64data?: string) {
        try {
            if (!base64data) {
                base64data = await fetchEncrypted("addresses");
                log.debug("Fetched deposit keys and change addresses");
            }

            // save resume link
            const params =
                "w=" +
                encodeURIComponent(confWithdrawalAddress) +
                "&d=" +
                encodeURIComponent(base64data);
            const baseURL = document.URL;
            if (baseURL.endsWith("?")) {
                // If the URL already ends with '?', directly append the parameters
                resumeLink = baseURL + params;
            } else {
                // If the URL has no parameters, start with '?'
                resumeLink = baseURL + "?" + params;
            }

            const addresses = decryptAddresses(base64data);

            depositKeys = addresses.Deposit;
            btcChangeAddress = addresses.ChangeBTC;
            tokenChangeAddress = addresses.ChangeToken;

            const blindingPublicKey = Buffer.from(
                depositKeys.PubBlind,
                "base64",
            );
            const publicKey = Buffer.from(depositKeys.PubKey, "base64");

            // Generate explicit address using P2WPKH
            explDepositAddress = payments.p2wpkh({
                pubkey: publicKey,
                network: network,
            }).address;

            // Convert to confidential
            confDepositAddress = address.toConfidential(
                explDepositAddress,
                blindingPublicKey,
            );
        } catch (error) {
            log.error("Error fetching new addresses:", error);
            hasError = true;
            renderPage();
        }
    }

    // append deposit UTXO to walletUTXOs
    async function appendDeposit(
        txid: string,
        vout: number,
    ): Promise<{ token: string; value: number }> {
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

            // increase balance
            if (depositKeys.token === info.Token) {
                balanceToken += depositKeys.value;
            } else if (depositKeys.token === "BTC") {
                balanceBTC += depositKeys.value;
            }
        }

        const token = depositKeys.token;
        const value = depositKeys.value;

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
        let selectedUTXOs: UTXO[] = [];
        const lastN = walletUTXOs.length - 1;

        let leftToAllocateToken = satsToken;
        let leftToAllocateBTC = satsBTC + satsFee;

        if (walletUTXOs[lastN].value > 0) {
            // add the newly deposited UTXO first
            selectedUTXOs.push(walletUTXOs[lastN]);

            if (walletUTXOs[lastN].token === "BTC") {
                leftToAllocateBTC -= walletUTXOs[lastN].value;
                totalBTC += walletUTXOs[lastN].value;
            } else {
                leftToAllocateToken -= walletUTXOs[lastN].value;
                totalToken += walletUTXOs[lastN].value;
            }
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
                if (leftToAllocateToken <= 0) {
                    break;
                }
                selectedUTXOs.push(utxo);
                leftToAllocateToken -= utxo.value;
                totalToken += utxo.value;
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

        for (const utxo of btcUTXOs) {
            if (leftToAllocateBTC <= 0) {
                break;
            }
            selectedUTXOs.push(utxo);
            leftToAllocateBTC -= utxo.value;
            totalBTC += utxo.value;
        }

        selectedUTXOs = scrambleArray(selectedUTXOs);

        return { selectedUTXOs, totalBTC, totalToken };
    }

    // fetches base64 response from wallet API
    async function fetchEncrypted(method: string): Promise<string> {
        const request = encryptRequest(method);
        const response = await fetch(`${config.apiUrl}/${request}`, {
            signal: AbortSignal.timeout(API_TIMEOUT),
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch: ${response.statusText}`);
        }
        const responseText = await response.text();
        if (responseText == "stale timestamp") {
            displayError = "Please synchronize your clock";
            throw new Error(`Failed to fetch: ${response.statusText}`);
        }
        return responseText;
    }

    // fetch wallet info, including private and blinding keys for UTXOs
    async function getInfo(): Promise<WalletInfo | null> {
        try {
            const response = await fetch(`${config.apiUrl}/info`, {
                signal: AbortSignal.timeout(API_TIMEOUT),
            });
            if (!response.ok) {
                throw new Error(`Failed to fetch: ${response.statusText}`);
            }
            return (await response.json()) as WalletInfo;
        } catch (error) {
            log.error("Error fetching Info:", error);
            throw error;
        }
    }

    function setStatus(status: string, append: boolean = false) {
        if (append) {
            statusText += "<br><br>" + status;
        } else {
            statusText = status;
        }
        const element = document.getElementById("status");
        if (element) {
            element.innerHTML = statusText;
        }
    }
})();
