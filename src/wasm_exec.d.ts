declare class Go {
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
    // Add any other methods and properties from wasm_exec.js as needed
}
