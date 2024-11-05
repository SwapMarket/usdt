import { WASI, init } from "@wasmer/wasi";

export async function getApiUrl(): Promise<string> {
    // This is needed to load the WASI library first (since is a Wasm module)
    await init();

    const wasi = new WASI({});

    // Fetch the WASM module
    const wasmBytes = await fetch("/wasi_module.wasm");

    // Compile the module
    const module = await WebAssembly.compileStreaming(wasmBytes);

    // Instantiate the WASI module
    wasi.instantiate(module, {});

    // Run the start function
    let exitCode = wasi.start();
    let stdout = wasi.getStdoutString();

    // This should print API URL
    if (exitCode == 0) {
        return stdout;
    }

    return "";
}
