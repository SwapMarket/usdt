#!/bin/bash

# Load environment variables from .env file
export $(grep -v '^#' .env | xargs)

cd go-wasm
GOOS=js GOARCH=wasm go build -ldflags="-X 'main.decryptionPrivKey=$PRIV_KEY' -X 'main.encryptionPubKey=$PUB_KEY'" -o ../public/wasm/main.wasm main.go