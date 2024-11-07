const WASM_URL = 'wasm/main.wasm';
const WASM_EXEC_URL = '/usdt/wasm_exec.js';

declare const Go: any;
declare function multiply(a: number, b: number): number;

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
    
    go.importObject.env = {
        'add': function(x, y) {
            return x + y
        }
        // ... other functions
    }
    
    // Fetch the WASM file and load it manually
    const response = await fetch(WASM_URL);
    const wasmBytes = await response.arrayBuffer();
    const wasmModule = await WebAssembly.instantiate(wasmBytes, go.importObject);
    const wasm = wasmModule.instance;

    go.run(wasm);

    

    // Calling the multiply function:
    console.log('multiplied two numbers:', multiply(5, 3));
}
