const WASM_URL = 'wasm/main.wasm';
const WASM_EXEC_URL = '/usdt/wasm_exec.js';

declare const Go: any;
declare function goDecodeUTXOs(base64Data: string): string;

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
    const wasmModule = await WebAssembly.instantiate(wasmBytes, go.importObject);
    const wasm = wasmModule.instance;

    go.run(wasm);

    console.log("WASM and Go runtime initialized");
}

// Repackage to export `decodeUTXOs` for usage in other files
export function decodeUTXOs(base64Data: string): any {
    return JSON.parse(goDecodeUTXOs(base64Data));
}
