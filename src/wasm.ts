const WASM_URL = "wasm/main.wasm";
const WASM_EXEC_URL = "/usdt/wasm_exec.js";

declare const Go: any;
declare function goDecryptUTXOs(base64Data: string, target: string): string;
declare function goGetBlindingKey(n: number): string;
declare function goGetPrivateKey(n: number): string;
declare function goSaveNewKeys(): string;

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

// Repackage for usage in other files
export function decryptUTXOs(base64Data: string, target: string): any {
    return JSON.parse(goDecryptUTXOs(base64Data, target));
}

export function getBlindingKey(n: number): any {
    return goGetBlindingKey(n);
}

export function getPrivateKey(n: number): any {
    return goGetPrivateKey(n);
}

export function saveNewKeys() {
    goSaveNewKeys();
}
