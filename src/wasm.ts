import "./wasm_exec";

export async function loadWasm() {
    const go = new Go(); 

    // Load and instantiate the WASM module
    const wasmModule = await WebAssembly.instantiateStreaming(
        fetch("/src/wasm/go-module.wasm"),
        go.importObject,
    );
    go.run(wasmModule.instance);

    return globalThis; // Go functions are available on the global scope
}
