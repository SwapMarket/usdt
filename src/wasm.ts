import "./wasm_exec";

export async function loadWasm() {
    const go = new Go(); 

    // Fetch the WASM file and load it manually
    const response = await fetch("wasm/main.wasm");
    const wasmBytes = await response.arrayBuffer();
    const wasmModule = await WebAssembly.instantiate(wasmBytes, go.importObject);
    go.run(wasmModule.instance);

    return globalThis; // Go functions are available on the global scope
}
