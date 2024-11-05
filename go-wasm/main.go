package main

import (
	"syscall/js"

	"github.com/mr-tron/base58"
)

func encodeBase58(this js.Value, inputs []js.Value) interface{} {
	input := inputs[0].String()
	encoded := base58.Encode([]byte(input))
	return js.ValueOf(encoded)
}

func main() {
	// Register the Go function to be called from JavaScript
	js.Global().Set("encodeBase58", js.FuncOf(encodeBase58))

	// Keep the Go WASM runtime running
	select {}
}
