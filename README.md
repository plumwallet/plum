# Plum

A self-custodial wallet for Solana, Ethereum and Bitcoin, as a browser extension for Firefox and Chromium-based
browsers (Chrome, Brave, Edge, Opera).

## Features

- One recovery phrase, every chain: each wallet has a Solana address, an Ethereum address (used on Ethereum, Base,
  Arbitrum and Polygon) and two Bitcoin addresses, native SegWit and Taproot.
- Accounts: each account is a recovery phrase (12 or 24 words) holding any number of wallets. Importing a phrase finds
  every wallet on it that has been used. Single private keys can be imported too.
- Ledger hardware wallets in Chrome, Brave, Edge and Opera (Firefox has no WebHID). Plum keeps only a Ledger's
  addresses; everything it signs is approved in Plum's window first, then on the device, and the device's answer is
  checked before anything is sent.
- Connects to dApps: Solana sites through the Wallet Standard (legacy, v0 and v1 transactions), Ethereum sites through
  EIP-6963 on all four networks, and Bitcoin sites through WBIP-004 (sats-connect) and the Wallet Standard's
  `bitcoin:*` features.
- Transactions are simulated before you approve them, and common drainer patterns (unlimited approvals, permits,
  authority changes, PSBT signatures that let others take a coin) are flagged.
- Send SOL, ETH, POL, BTC and tokens. Swap on Solana through Jupiter, and on Ethereum, Base, Arbitrum and Polygon
  through KyberSwap. One history across every chain.
- Stake SOL with a validator, or ETH with Lido.
- NFTs on Solana (Metaplex, programmable, Core and compressed) and on Ethereum's networks (ERC-721 and ERC-1155),
  listed and sent. Token and NFT images are never loaded.
- Phishing protection from Phantom's public blocklist plus lookalike-domain checks.

## Derivation paths

Plum uses the same paths as Phantom, so an existing recovery phrase shows the same addresses.

| Chain | Wallet *n* |
|---|---|
| Solana | `m/44'/501'/n'/0'` |
| Ethereum, Base, Arbitrum, Polygon | `m/44'/60'/0'/0/n` |
| Bitcoin, native SegWit | `m/84'/0'/0'/0/n` (`bc1q…`) |
| Bitcoin, Taproot | `m/86'/0'/0'/0/n` (`bc1p…`, BIP-86) |

Importing a phrase also checks Phantom's older layout and the Solana CLI's default key. Ledger wallets use the same
paths, plus Ledger Live's `m/44'/501'/n'` (Solana) and `m/44'/60'/n'/0/0` (Ethereum) when those have been used.

## Security

- Recovery phrases and keys are encrypted with your password (scrypt, then AES-256-GCM) and never leave the extension.
  While unlocked, the key is held in memory and in `storage.session`, which is never written to disk. The wallet locks
  automatically.
- Only the background script handles keys. Web pages, content scripts and the popup never see them. A Ledger wallet
  holds no secret in Plum: the vault keeps its addresses and paths, checked at every unlock like the others.
- Sites can only make requests. Every connection, signature and transaction is approved in Plum's own window, which a
  page can't draw over. An Ethereum site's request stays on the network it was made on.
- `eth_sign`, `eth_signTransaction` and v1 typed data are refused. Messages are shown as text, and EIP-712 data field by
  field.
- Swaps are read and simulated before you approve them: token approvals are for the exact amount, and a swap is
  refused if anything else would leave the wallet.
- A Bitcoin site's PSBT is checked against the chain, and Plum signs only the wallet's own inputs.
- Every transaction Plum builds has exactly one signer: your wallet. Stake accounts are made from the wallet with a
  seed for the same reason.
- No analytics or telemetry.
- Runtime dependencies are limited to `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`, `@scure/bip39`
  and `uqr` (QR codes). Ethereum and Bitcoin transactions, PSBTs and the Ledger protocol are encoded in this codebase
  and tested against viem, bitcoinjs-lib and Ledger's own apps. Bundles are not minified.

## Build and install

Requires Node.js 22 or later.

```bash
npm ci --ignore-scripts
npm run build
```

This writes `dist/firefox/` and `dist/chromium/`.

- **Chrome, Brave, Edge, Opera:** open the extensions page, turn on Developer mode, click **Load unpacked** and choose
  `dist/chromium/`.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on** and choose
  `dist/firefox/manifest.json`. Temporary add-ons are removed when Firefox restarts; a permanent install needs a build
  signed by Mozilla.

## Network

| | Source |
|---|---|
| Solana | `https://plum.fun/rpc`, a proxy that keeps the RPC provider's key on the server (see [`proxy/`](proxy/)); NFTs through its DAS methods |
| Ethereum, Base, Arbitrum, Polygon | publicnode, dRPC and 1RPC; Ethereum transactions go through MEV Blocker first; tokens, history and NFTs from Blockscout |
| Bitcoin | mempool.space, falling back to blockstream.info; inscriptions and runes from ordinals.com, falling back to Xverse's public API |
| Prices | CoinGecko |
| Swaps | Jupiter (Solana), KyberSwap (Ethereum, Base, Arbitrum, Polygon) |
| Staking | Solana's stake program, Lido (Ethereum) |

Settings accept your own Solana RPC, and your own RPC for each Ethereum network. To build against a different Solana
RPC: `node build.mjs --rpc <url>`.

## Development

```bash
npm run watch           # rebuild on change
npm test                # unit and integration tests in Node
npm run e2e:chromium    # end-to-end in headless Chrome
npm run e2e             # end-to-end in Firefox Developer Edition
npm run smoke:chromium  # quick Chrome check
npm run redteam         # adversarial tests in Firefox
npm run lint            # web-ext lint
npm run pack            # zip both builds into artifacts/
npm run sign            # sign the Firefox build with Mozilla (API credentials in amo.local.txt)
```

`node scripts/e2e-btc-chromium.mjs` runs the Bitcoin screens and a Bitcoin dApp end to end in headless Chrome.
`node scripts/ledger-speculos.mjs --elf <dir>` runs the Ledger clients against Ledger's own apps in its Speculos
emulator (Docker); `npm test` replays its recorded exchanges.

| Path | Contents |
|---|---|
| `src/background/` | vault, keys, signing, chain clients, request handling |
| `src/background/ledger/` | the Ledger transport (WebHID) and its Solana, Ethereum and Bitcoin app clients |
| `src/content/` | in-page providers (Wallet Standard, EIP-1193, WBIP-004) and the content-script bridge |
| `src/ui/` | popup and approval window |
| `src/shared/` | code shared across the extension |
| `test/` | tests; `test/redteam/` holds adversarial cases |
| `scripts/` | end-to-end tests, packaging, signing, icon generation |
| `proxy/` | the Solana RPC proxy behind plum.fun/rpc |

## Not supported yet

Ethereum testnets and other EVM networks, Taproot script-path spends and PSBT v2, sending inscriptions and runes from
Plum, and hardware wallets other than Ledger. Plum doesn't set `window.ethereum` or any other wallet's globals, so
sites that only look there won't find it.

## License

[MIT](LICENSE)
