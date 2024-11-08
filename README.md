# Liquid BTC/USDt Swaps

A proof-of-concept impementation of "Exchange in a Browser" idea. You trade against an open source code hosted at GitHub Pages. No third party involved, except to provide a bag of private keys to the website when the page loads. The rest happens automatically: if you deposit L-BTC, you get back L-USDt and vice versa. Kind of a large smart contract.

To prove available reserves, balances are computed from the keys. The deposit address is also derived from private and blinding keys. These keys, along with TxId and Vout are added to the wallet's UTXOs after funding. This insures automatic refund in an unlikely event that the purchased asset is not available (some other user purchased all or most of it while your trade was pending). 

All trades have blinded amounts and assets, with outputs randomized. Private keys are (hopefully!) protected by encription and code obfuscation.