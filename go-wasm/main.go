package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/gob"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"syscall/js"
	"time"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
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

// fetched from ENV
var decryptionPrivKey string
var encryptionPubKey string

// private keys vault
var walletKeys []Keys
var newKeys Keys

func main() {
	// Expose the functions to JavaScript
	js.Global().Set("goEncryptRequest", js.FuncOf(encryptRequest))
	js.Global().Set("goDecryptAddresses", js.FuncOf(decryptAddresses))
	js.Global().Set("goDecryptUTXOs", js.FuncOf(decryptUTXOs))
	js.Global().Set("goGetBlindingKey", js.FuncOf(getBlindingKey))
	js.Global().Set("goSaveNewKeys", js.FuncOf(saveNewKeys))
	js.Global().Set("goSign", js.FuncOf(sign))

	// Keep the functions active
	select {}
}

type InboundUTXO struct {
	TxId     string
	Vout     uint
	Private  []byte
	Blinding []byte
}

// 0: base64 encoded and encrypted GOB object
// returns UTXO object
func decryptUTXOs(this js.Value, p []js.Value) interface{} {
	base64data := p[0].String()

	var inbound []InboundUTXO

	err := decryptObject(base64data, &inbound)
	if err != nil {
		return nil
	}

	var utxos []UTXO

	// delete keys
	walletKeys = []Keys{}

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
		walletKeys = append(walletKeys, keys)
	}

	// Convert `utxos` to JSON to return a JavaScript-friendly format
	jsonData, err := json.Marshal(utxos)
	if err != nil {
		return nil
	}

	return js.ValueOf(string(jsonData))
}

// 0: base64 encoded and encrypted GOB object
// returns Addresses object
func decryptAddresses(this js.Value, p []js.Value) interface{} {
	base64data := p[0].String()

	type InboundAddresses struct {
		Deposit     InboundUTXO
		ChangeBTC   string
		ChangeToken string
	}

	var inbound InboundAddresses

	err := decryptObject(base64data, &inbound)
	if err != nil {
		return nil
	}

	newKeys = Keys{
		Private:  inbound.Deposit.Private,
		Blinding: inbound.Deposit.Blinding,
	}

	_, pubKey := btcec.PrivKeyFromBytes(inbound.Deposit.Private)
	_, pubBlind := btcec.PrivKeyFromBytes(inbound.Deposit.Blinding)

	utxo := UTXO{
		N:        0,
		TxId:     inbound.Deposit.TxId,
		Vout:     inbound.Deposit.Vout,
		PubKey:   base64.StdEncoding.EncodeToString(pubKey.SerializeCompressed()),
		PubBlind: base64.StdEncoding.EncodeToString(pubBlind.SerializeCompressed()),
	}

	type Addresses struct {
		Deposit     UTXO
		ChangeBTC   string
		ChangeToken string
	}

	result := Addresses{
		Deposit:     utxo,
		ChangeBTC:   inbound.ChangeBTC,
		ChangeToken: inbound.ChangeToken,
	}

	// Convert to JSON to return a JavaScript-friendly format
	jsonData, err := json.Marshal(result)
	if err != nil {
		return nil
	}

	return js.ValueOf(string(jsonData))
}

// decrypts any data
func decryptObject(base64data string, target any) error {
	serializedKey, err := hex.DecodeString(decryptionPrivKey)
	if err != nil {
		return err
	}

	privKey, _ := btcec.PrivKeyFromBytes(serializedKey)

	ciphertext, err := base64.StdEncoding.DecodeString(base64data)
	if err != nil {
		return err
	}

	// decrypt with private key
	ephemeralPubKey, err := btcec.ParsePubKey(ciphertext[:33])
	if err != nil {
		return err
	}

	nonce := ciphertext[33 : 33+chacha20poly1305.NonceSize]
	encryptedMessage := ciphertext[33+chacha20poly1305.NonceSize:]

	sharedSecret := sha256.Sum256(btcec.GenerateSharedSecret(privKey, ephemeralPubKey))

	hkdf := hkdf.New(sha256.New, sharedSecret[:], nil, nil)
	encryptionKey := make([]byte, chacha20poly1305.KeySize)
	if _, err := io.ReadFull(hkdf, encryptionKey); err != nil {
		return err
	}

	aead, err := chacha20poly1305.New(encryptionKey)
	if err != nil {
		return err
	}

	decryptedMessage, err := aead.Open(nil, nonce, encryptedMessage, nil)
	if err != nil {
		return err
	}

	var buffer bytes.Buffer
	buffer.Write(decryptedMessage)

	// Deserialize binary data
	decoder := gob.NewDecoder(&buffer)
	if err := decoder.Decode(target); err != nil {
		return err
	}

	return nil
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

// appends newKeys to walletKeys
func saveNewKeys(this js.Value, p []js.Value) interface{} {
	walletKeys = append(walletKeys, newKeys)
	return js.ValueOf(nil)
}

func encryptMessage(message any) string {
	// Serialize the message using gob
	var buffer bytes.Buffer
	encoder := gob.NewEncoder(&buffer)
	if err := encoder.Encode(message); err != nil {
		log.Println("Failed to encode GOB:", err)
		return ""
	}

	// Decode the hex string into a byte slice
	pubKeyBytes, err := hex.DecodeString(encryptionPubKey)
	if err != nil {
		log.Fatal("Error decoding hex string:", err)
		return ""
	}

	// Parse the public key bytes into a secp256k1.PublicKey
	pubKey, err := btcec.ParsePubKey(pubKeyBytes)
	if err != nil {
		log.Fatal("Error parsing public key:", err)
		return ""
	}

	ephemeralPrivKey, err := btcec.NewPrivateKey()
	if err != nil {
		log.Fatal("Error generating ephemeral key:", err)
		return ""
	}

	sharedSecret := sha256.Sum256(btcec.GenerateSharedSecret(ephemeralPrivKey, pubKey))

	hkdf := hkdf.New(sha256.New, sharedSecret[:], nil, nil)
	encryptionKey := make([]byte, chacha20poly1305.KeySize)
	if _, err := io.ReadFull(hkdf, encryptionKey); err != nil {
		return ""
	}

	aead, err := chacha20poly1305.New(encryptionKey)
	if err != nil {
		return ""
	}

	nonce := make([]byte, chacha20poly1305.NonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return ""
	}

	ciphertext := aead.Seal(nil, nonce, buffer.Bytes(), nil)

	result := append(ephemeralPrivKey.PubKey().SerializeCompressed(), nonce...)
	result = append(result, ciphertext...)

	return base64.StdEncoding.EncodeToString(result)
}

// 0: request
// returns Request object
func encryptRequest(this js.Value, p []js.Value) interface{} {
	type Request struct {
		Request   string
		Arg       string
		TimeStamp int64
	}

	message := encryptMessage(&Request{
		Request:   p[0].String(),
		TimeStamp: time.Now().Unix(),
	})

	return js.ValueOf(message)
}

// 0: Hex-encoded preimage
// 1: key number to use
// returns hex string
func sign(this js.Value, p []js.Value) interface{} {
	// Decode the hex string into bytes
	data, err := hex.DecodeString(p[0].String())
	if err != nil {
		return js.ValueOf("Failed to decode hex string: " + err.Error())
	}

	// Parse the private key using btcec
	privateKey := secp256k1.PrivKeyFromBytes(walletKeys[p[1].Int()].Private)

	// Sign the data
	derSignature := ecdsa.Sign(privateKey, data).Serialize()

	// Convert DER to raw (r|s) signature
	signature, err := derToRaw(derSignature)
	if err != nil {
		return js.ValueOf("Failed to convert signature: " + err.Error())
	}

	// Return the raw signature as a hex string
	return js.ValueOf(hex.EncodeToString(signature))
}

// Convert DER-encoded signature to raw 64-byte signature
func derToRaw(derSignature []byte) ([]byte, error) {
	// Parse the DER-encoded signature
	signature, err := ecdsa.ParseDERSignature(derSignature)
	if err != nil {
		return nil, err
	}

	// Extract R and S values
	r := signature.R()
	s := signature.S()

	// Convert R and S to byte slices
	rBytes := r.Bytes()
	sBytes := s.Bytes()

	// Ensure R and S are padded to 32 bytes
	if len(rBytes) > 32 || len(sBytes) > 32 {
		return nil, errors.New("invalid signature: R or S exceeds 32 bytes")
	}

	// Create slices for padding
	rPadded := make([]byte, 32)
	sPadded := make([]byte, 32)

	// Copy rBytes and sBytes into the padded slices
	copy(rPadded[32-len(rBytes):], rBytes[:])
	copy(sPadded[32-len(sBytes):], sBytes[:])

	// Concatenate R and S
	return append(rPadded, sPadded...), nil
}
