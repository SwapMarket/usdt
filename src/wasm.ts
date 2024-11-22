import log from "loglevel";

import type { UTXO, WalletInfo } from "./consts/Types";
import { isUTXO } from "./consts/Types";

const WASM_URL = "wasm/main.wasm";
const WASM_EXEC_URL = "/usdt/wasm_exec.js";

type GoConstructor = new () => {
    argv: string[];
    env: { [key: string]: string };
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): void;
    exit(code: number): void;
};

// Declare `Go` with the constructor type
declare const Go: GoConstructor;

declare function goEncryptRequest(request: string, arg: string): string;
declare function goDecryptUTXOs(base64Data: string, target: string): string;
declare function goDecryptInfo(base64Data: string): string;
declare function goDecryptString(base64Data: string): string;
declare function goGetBlindingKey(n: number): string;
declare function goSaveNewKeys(): string;
declare function goSign(hexPreimage: string, n: number): string;

export async function loadWasm() {
    // Dynamically load `wasm_exec.js` from the public folder
    await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = WASM_EXEC_URL;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load wasm_exec.js"));
        document.head.appendChild(script);
    });

    // Instantiate Go after wasm_exec.js is loaded
    const go = new Go();

    // Fetch the WASM file and load it manually
    const response = await fetch(WASM_URL);
    const wasmBytes = await response.arrayBuffer();
    const wasmModule = await WebAssembly.instantiate(
        wasmBytes,
        go.importObject,
    );
    const wasm = wasmModule.instance;

    go.run(wasm);
}

export function encryptRequest(request: string, arg: string): string {
    return goEncryptRequest(request, arg);
}

export function decryptUTXOs(
    base64Data: string,
    target: string,
): UTXO[] | null {
    if (base64Data == "stale timestamp") {
        log.error("Please synchronize your clock");
        return null;
    }

    const result = JSON.parse(goDecryptUTXOs(base64Data, target));

    // Ensure `result` is an array of `UTXO` objects
    if (Array.isArray(result) && result.every(isUTXO)) {
        return result;
    }

    throw new Error("Invalid data format received from goDecryptUTXOs");
}

export function decryptInfo(base64Data: string): WalletInfo | null {
    if (base64Data == "stale timestamp") {
        log.error("Please synchronize your clock");
        return null;
    }

    const jsonString = goDecryptInfo(base64Data);
    const walletInfo = JSON.parse(jsonString) as WalletInfo;
    return walletInfo;
}

export function decryptString(base64Data: string): string {
    if (base64Data == "stale timestamp") {
        log.error("Please synchronize your clock");
        return "";
    }
    return goDecryptString(base64Data);
}

export function getBlindingKey(n: number): string {
    return goGetBlindingKey(n);
}

export function saveNewKeys() {
    goSaveNewKeys();
}

export function signPreimage(preimage: Buffer, n: number): Buffer {
    return Buffer.from(goSign(preimage.toString("hex"), n), "hex");
}
