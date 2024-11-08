package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/gob"
	"encoding/hex"
	"encoding/json"
	"io"
	"syscall/js"

	"github.com/btcsuite/btcd/btcec/v2"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/hkdf"
)

type Keys struct {
	Private  []byte
	Blinding []byte
}

type UTXO struct {
	N        int
	TxId     string
	Vout     uint
	PubKey   string
	PubBlind string
}

// decription private key
var decryptionPrivKey string

// private keys vault
var walletKeys []Keys
var newKeys Keys

func main() {
	// Expose the functions to JavaScript
	js.Global().Set("goDecryptUTXOs", js.FuncOf(decryptUTXOs))
	js.Global().Set("goGetBlindingKey", js.FuncOf(getBlindingKey))
	js.Global().Set("goGetPrivateKey", js.FuncOf(getPrivateKey))
	js.Global().Set("goSaveNewKeys", js.FuncOf(saveNewKeys))

	// Keep the functions active
	select {}
}

// 0: base64 encoded and encrypted GOB object
// 1: "wallet" or "new"
// returns UTXO object
func decryptUTXOs(this js.Value, p []js.Value) interface{} {
	base64data := p[0].String()
	target := p[1].String()

	serializedKey, err := hex.DecodeString(decryptionPrivKey)
	if err != nil {
		return nil
	}

	privKey, _ := btcec.PrivKeyFromBytes(serializedKey)

	ciphertext, err := base64.StdEncoding.DecodeString(base64data)
	if err != nil {
		return nil
	}

	// decrypt with private key
	ephemeralPubKey, err := btcec.ParsePubKey(ciphertext[:33])
	if err != nil {
		return nil
	}

	nonce := ciphertext[33 : 33+chacha20poly1305.NonceSize]
	encryptedMessage := ciphertext[33+chacha20poly1305.NonceSize:]

	sharedSecret := sha256.Sum256(btcec.GenerateSharedSecret(privKey, ephemeralPubKey))

	hkdf := hkdf.New(sha256.New, sharedSecret[:], nil, nil)
	encryptionKey := make([]byte, chacha20poly1305.KeySize)
	if _, err := io.ReadFull(hkdf, encryptionKey); err != nil {
		return nil
	}

	aead, err := chacha20poly1305.New(encryptionKey)
	if err != nil {
		return nil
	}

	decryptedMessage, err := aead.Open(nil, nonce, encryptedMessage, nil)
	if err != nil {
		return nil
	}

	var buffer bytes.Buffer
	buffer.Write(decryptedMessage)

	type Inbound struct {
		TxId     string
		Vout     uint
		Private  []byte
		Blinding []byte
	}

	var inbound []Inbound
	// Deserialize binary data
	decoder := gob.NewDecoder(&buffer)
	if err := decoder.Decode(&inbound); err != nil {
		return nil
	}

	var utxos []UTXO

	if target == "utxos" {
		// delete keys
		walletKeys = []Keys{}
	}

	// move keys to vault and utxos for export
	for i, inbound := range inbound {
		keys := Keys{
			Private:  inbound.Private,
			Blinding: inbound.Blinding,
		}

		_, pubKey := btcec.PrivKeyFromBytes(inbound.Private)
		_, pubBlind := btcec.PrivKeyFromBytes(inbound.Blinding)

		utxo := UTXO{
			N:        i,
			TxId:     inbound.TxId,
			Vout:     inbound.Vout,
			PubKey:   base64.StdEncoding.EncodeToString(pubKey.SerializeCompressed()),
			PubBlind: base64.StdEncoding.EncodeToString(pubBlind.SerializeCompressed()),
		}

		utxos = append(utxos, utxo)

		if target == "new" {
			newKeys = keys
			break
		}
		if target == "wallet" {
			walletKeys = append(walletKeys, keys)
		}
	}

	// Convert `utxos` to JSON to return a JavaScript-friendly format
	jsonData, err := json.Marshal(utxos)
	if err != nil {
		return nil
	}

	return js.ValueOf(string(jsonData))
}

// 0: N, -1 means newKey
func getBlindingKey(this js.Value, p []js.Value) interface{} {
	n := p[0].Int()

	key := newKeys.Blinding
	if n >= 0 {
		key = walletKeys[n].Blinding
	}
	keyStr := base64.StdEncoding.EncodeToString(key)
	return js.ValueOf(keyStr)
}

// 0: N, -1 means newKey
func getPrivateKey(this js.Value, p []js.Value) interface{} {
	n := p[0].Int()

	key := newKeys.Private
	if n >= 0 {
		key = walletKeys[n].Private
	}
	keyStr := base64.StdEncoding.EncodeToString(key)
	return js.ValueOf(keyStr)
}

// appends newKeys to walletKeys
func saveNewKeys(this js.Value, p []js.Value) interface{} {
	walletKeys = append(walletKeys, newKeys)
	return js.ValueOf(nil)
}
