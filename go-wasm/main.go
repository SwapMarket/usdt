package main

import (
	"bytes"
	"encoding/base64"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"syscall/js"
)

// This calls a JS function from Go.
func main() {
	// Expose the `decodeUTXOs` function to JavaScript
	js.Global().Set("goDecodeUTXOs", js.FuncOf(decodeUTXOs))

	// Keep the function active
	select {}
}

func decodeUTXOs(this js.Value, p []js.Value) interface{} {
	decoded, err := base64.StdEncoding.DecodeString(p[0].String())
	if err != nil {
		fmt.Printf("Failed to decode base64:", err)
		return nil
	}

	var buffer bytes.Buffer

	// Write the byte slice into the buffer
	buffer.Write(decoded)

	type UTXO struct {
		TxId string
		Vout uint
		P    []byte // public key hex
		R    []byte // private key hex
		B    []byte // blinding key hex
	}

	var utxos []UTXO
	// Deserialize binary data
	decoder := gob.NewDecoder(&buffer)
	if err := decoder.Decode(&utxos); err != nil {
		fmt.Println("Cannot deserialize the received message ")
		return nil
	}

	// Convert `utxos` to JSON to return a JavaScript-friendly format
	jsonData, err := json.Marshal(utxos)
	if err != nil {
		fmt.Println("Failed to marshal JSON:", err)
		return nil
	}

	return js.ValueOf(string(jsonData))
}
