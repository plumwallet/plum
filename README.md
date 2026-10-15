# Plum

A self-custodial wallet for Solana, Ethereum and Bitcoin, as a browser extension for Firefox and Chromium-based
browsers (Chrome, Brave, Edge, Opera).

## Features

- One recovery phrase, three chains: every wallet has a Solana, an Ethereum and a Bitcoin address.
- Accounts: each account is a recovery phrase (12 or 24 words) holding any number of wallets. Importing a phrase finds
  every wallet on it that has been used. Single private keys can be imported too.
- Connects to dApps: Solana sites through the Wallet Standard, Ethereum sites through EIP-6963.
- Transactions are simulated before you approve them, and common drainer patterns (unlimited approvals, permits,
  authority changes) are flagged.
- Send SOL, ETH, BTC and tokens, swap on Solana through Jupiter, and see one history across all three chains.
- Phishing protection from Phantom's public blocklist plus lookalike-domain checks.

## Derivation paths

Plum uses the same paths as Phantom, so an existing recovery phrase shows the same addresses.

| Chain | Wallet *n* |
|---|---|
| Solana | `m/44'/501'/n'/0'` |
| Ethereum | `m/44'/60'/0'/0/n` |
| Bitcoin | `m/84'/0'/0'/0/n` (native SegWit, `bc1q…`) |

Importing a phrase also checks Phantom's older layout and the Solana CLI's default key.

## Security

- Recovery phrases and keys are encrypted with your password (scrypt, then AES-256-GCM) and never leave the extension.
  While unlocked, the key is held in memory and in `storage.session`, which is never written to disk. The wallet locks
  automatically.
- Only the background script handles keys. Web pages, content scripts and the popup never see them.
- Sites can only make requests. Every connection, signature and transaction is approved in Plum's own window, which a
  page can't draw over.
- `eth_sign`, `eth_signTransaction` and v1 typed data are refused. Messages are shown as text, and EIP-712 data field by
  field.
- Every transaction Plum builds has exactly one signer: your wallet.
- No analytics or telemetry.
- Runtime dependencies are limited to `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`, `@scure/bip39`
  and `uqr` (QR codes). Ethereum and Bitcoin transactions are encoded in this codebase and tested against viem and
  bitcoinjs-lib. Bundles are not minified.

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
| Solana | `https://plum.fun/rpc`, a proxy that keeps the RPC provider's key on the server (see [`proxy/`](proxy/)) |
| Ethereum | publicnode, dRPC and 1RPC; transactions go through MEV Blocker first; tokens and history from Blockscout |
| Bitcoin | mempool.space, falling back to blockstream.info |
| Prices | CoinGecko |
| Swaps | Jupiter (Solana) |

Settings accept your own Solana or Ethereum RPC. To build against a different Solana RPC: `node build.mjs --rpc <url>`.

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

| Path | Contents |
|---|---|
| `src/background/` | vault, keys, signing, chain clients, request handling |
| `src/content/` | in-page providers (Wallet Standard, EIP-1193) and the content-script bridge |
| `src/ui/` | popup and approval window |
| `src/shared/` | code shared across the extension |
| `test/` | tests; `test/redteam/` holds adversarial cases |
| `scripts/` | end-to-end tests, packaging, signing, icon generation |
| `proxy/` | the Solana RPC proxy behind plum.fun/rpc |

## Not supported yet

Taproot (`bc1p`) receive addresses, Ethereum L2s and testnets, swaps on Ethereum, NFTs, staking and hardware wallets.
Plum doesn't set `window.ethereum`, so sites that only look there won't find it.

## License

[MIT](LICENSE)
