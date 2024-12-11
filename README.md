# Liquid BTC/USDt Swaps

A proof-of-concept implementation of "Exchange in a Browser". You trade against an open source code hosted at GitHub Pages. No third party involved, except to provide a set of private keys + UTXOs when the page loads. The rest happens automatically: if you deposit L-BTC, you get back L-USDt and vice versa. Kind of a large smart contract.

## FAQ

- Is this trustless? 

To prove available reserves, UTXO balances are fetched from a third party explorer (blockstream.info). Your deposit address is derived from a private/blinding key pair. These keys, along with your funding TxId and Vout are added to the available UTXOs. This ensures automatic refund in an unlikely event that the purchased asset is no longer available (some other user purchased all or most of it while your trade was pending). 

Once the deposit address is displayed, your withdrawal will be performed by the web app and is not conditional on the backend. Its source code is intentionally minimalistic with most action happening in index.ts. The deployment to GitHub Pages has provenance attestation. A technical person should have no problem to prove to himself that the whole process is trustless.

- How private is this?

Liquid Network was built for privacy. All trades have blinded amounts and assets, with the order of inputs and outputs in your withdrawal randomized. Our backend does not reuse the addresses and keeps no logs. An outside observer cannot see what you exchanged for what. However, your IP address can be logged by GitHub or API endpoints, so we recommend using a VPN or the Tor Browser.

- How does this compare to competition?

Boltz does not trade BTC/USDt because of the [free option problem](https://blog.boltz.exchange/p/the-problem-with-free-options-69f9f59a2d48). SideSwap requires you to use their own wallet to avoid it. Another approach - SideShift - is to charge you extra spread for it. There are also CEX'es, which are KYC and custodial. Our solution aims to provide a cheaper, faster, non-custodial and private way to trade.

- Why is nobody else doing this?

It is very tricky to let a web app handle private keys, while making its source code open. We implemented security measures, but won't discuss them here. To report vilnerability, please send us an [email](mailto:swapmarket.wizard996@passinbox.com).

- What if I lose internet connection after funding the swap?

If you funded the deposit, but the website goes offline before sending the withdrawal back to you, it will display "resume link". Save it in your browser's bookmarks to try again when your internet is back. If you closed your browser before saving the link, send us your deposit txid by [email](mailto:swapmarket.wizard996@passinbox.com) and we'll look to resolve this.