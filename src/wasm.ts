import type { Addresses, UTXO } from "./consts/Types";
import { isUTXO } from "./consts/Types";

const WASM_URL = "wasm/main.wasm";
const WASM_EXEC_URL = "wasm/wasm_exec.js";

type GoConstructor = new () => {
    argv: string[];
    env: { [key: string]: string };
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): void;
    exit(code: number): void;
};

// Declare `Go` with the constructor type
declare const Go: GoConstructor;

declare function goEncryptRequest(request: string): string;
declare function goDecryptUTXOs(base64Data: string): string;
declare function goDecryptAddresses(base64Data: string): string;
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

export function encryptRequest(request: string): string {
    return goEncryptRequest(request);
}

export function decryptUTXOs(base64Data: string): UTXO[] {
    const result = JSON.parse(goDecryptUTXOs(base64Data));

    // Ensure `result` is an array of `UTXO` objects
    if (Array.isArray(result) && result.every(isUTXO)) {
        return result;
    }

    throw new Error("Invalid data format received from goDecryptUTXOs");
}

export function decryptAddresses(base64Data: string): Addresses {
    const jsonString = goDecryptAddresses(base64Data);
    return JSON.parse(jsonString) as Addresses;
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
